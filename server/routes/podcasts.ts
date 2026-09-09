// Beehiiv episode catalog.
//
// Proxies the Beehiiv Podcasts API and projects the response down to our
// Episode shape. Three routes:
//
//   GET /api/podcasts/episodes — list. Summaries only, no show notes.
//   GET /api/podcasts/episode  — one episode, with show notes html.
//   GET /api/podcasts/show     — show-level metadata (description).
//
// All three are cached in-process AND behind an edge cache-control header.
// The in-process layer only deduplicates concurrent calls on one warm
// instance (see shared/ttl-cache.ts); the header is what stops every cold
// start from paying for the slowest upstream in the app.
//
// The API token can't ride along with the client, so every one of these is a
// server-side proxy. Beehiiv nests podcasts under a publication:
//   /v2/publications/{publicationId}/podcasts/{podcastShowId}/episodes

import {
  isPublishedEpisode,
  projectBeehiivEpisode,
  projectBeehiivEpisodeSummary,
  stripHtml,
  type BeehiivEpisode,
  type BeehiivPodcast,
  type EpisodeSummary,
  type ProjectedEpisode,
} from '../show-notes.js'
import { defineRoute, type Deps, type Env, type Route } from '../lib/route.js'
import { fetchWithTimeout, setReadCacheControl } from '../lib/http.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import { resolveMembership } from '../lib/entitlement-resolver.js'
import { getShow, shows } from '../../src/data/shows.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

const BEEHIIV_API_BASE = 'https://api.beehiiv.com/v2'

// How many episodes a show page starts with. Matches the page size Simplecast
// served, and `EpisodeBrowser` reveals them a screen at a time from there.
const EPISODE_LIST_SIZE = 50

// Beehiiv's list endpoint does its work per episode, not per request: measured
// against our own shows it runs ~80-160ms per episode almost perfectly linearly
// (call-me-back: 0.32s at limit=1, 1.02s at 10, 4.16s at 50, 8.92s at 100), and
// it caches nothing — three identical limit=50 calls came back in 4.37/4.42/4.16s.
// Requesting a smaller page is the ONLY thing that makes it faster; there is no
// field selection (`fields`, `exclude` and `hide` are all accepted and silently
// ignored) and compression is beside the point (gzip takes 68KB to 11KB with no
// change in wall time, because the time is spent upstream, not on the wire).
//
// So we buy the whole list as several small pages at once instead of one big
// one. Measured end-to-end, same 50 episodes:
//
//   chosen-people-problems   7.79s one-shot  ->  2.14s paged   (3.6x)
//   call-me-back             4.16s one-shot  ->  1.50s paged   (2.8x)
//
// `page` is a real offset — pages carry distinct episodes, out-of-range pages
// come back empty rather than repeating — and the flattened result was verified
// identical, in the same order, to the one-shot response.
const EPISODE_PAGE_SIZE = 10
const EPISODE_PAGE_COUNT = Math.ceil(EPISODE_LIST_SIZE / EPISODE_PAGE_SIZE)

// Offset pagination is only consistent against a list that isn't moving. An
// episode published between page 1 and page 4 landing shifts everything down by
// one, which shows up as the same episode appearing on two pages. Cheap to
// tolerate (dedupe on the way through) and impossible to prevent, so we tolerate
// it rather than reaching for the cursor API, which can't be walked in parallel
// and would put us back to one slow round-trip per page.
function dedupeById(episodes: BeehiivEpisode[]): BeehiivEpisode[] {
  const seen = new Set<string>()
  return episodes.filter((e) => {
    const id = e.id ?? ''
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const EPISODES_CACHE_TTL_MS = 5 * 60 * 1000
const episodesCache = makeTTLCache<string, EpisodeSummary[]>(
  EPISODES_CACHE_TTL_MS,
)

// Show notes change rarely and nothing else holds a second copy of them — the
// list deliberately drops the field — so this TTL answers only to how quickly
// a corrected set of notes should appear, not to any other cache it could
// disagree with.
const EPISODE_CACHE_TTL_MS = 30 * 60 * 1000
const episodeCache = makeTTLCache<string, ProjectedEpisode>(
  EPISODE_CACHE_TTL_MS,
)

// Show-level metadata (title, description) changes very rarely — on the order
// of months — so it gets a much longer TTL than episodes or show notes. The
// cache still resets on each serverless cold start, bounding staleness.
const SHOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const showCache = makeTTLCache<string, string>(SHOW_CACHE_TTL_MS)

// The cross-show "latest episodes" strip. Separate from `episodesCache` because
// it holds a different thing — the newest episode of each public show, not one
// show's list — and shares its 5 minute TTL because a new episode should
// surface on /podcasts as promptly as on the show page.
const latestCache = makeTTLCache<string, EpisodeSummary[]>(EPISODES_CACHE_TTL_MS)

// Upper bound on `?limit`. The podcasts page wants one card per public show;
// the cap only exists so the parameter can't be turned into a request for
// every episode of every show.
const LATEST_MAX = 12
const LATEST_DEFAULT = 4

type BeehiivListResponse = { data?: BeehiivEpisode[] }
type BeehiivShowResponse = { data?: BeehiivPodcast }

/** Resets the process-global caches (unit tests only). */
export function clearPodcastCaches(): void {
  episodesCache.clear()
  episodeCache.clear()
  showCache.clear()
  latestCache.clear()
}

// Beehiiv ids are opaque and may carry a type prefix (`pod_`, `pub_`). Accept
// that alphabet only — these are interpolated into the upstream URL, so the
// point is to make path traversal and env-key probing impossible, not to
// validate the id's exact format.
const BEEHIIV_ID = /^[A-Za-z0-9_-]{1,64}$/

function resolvePodcastId(env: Env, showSlug: string): string | undefined {
  // Accept only the slug pattern we expect so a caller can't probe arbitrary
  // env keys by injecting an unusual `show` value.
  if (!/^[a-z0-9-]+$/.test(showSlug)) return undefined
  const key = `BEEHIIV_PODCAST_ID_${showSlug.toUpperCase().replace(/-/g, '_')}`
  const value = env[key]?.trim()
  if (!value) return undefined
  // Beehiiv enforces `^pod_[0-9a-fA-F-]+$` on this path segment and rejects a
  // bare UUID with a 400. The dashboard and several of their own surfaces show
  // the id unprefixed, so accept both and normalise rather than making every
  // future config edit a guess about which form is wanted.
  const normalized = value.startsWith('pod_') ? value : `pod_${value}`
  // Same check the publication id gets. A malformed value here (a pasted
  // dashboard URL, an id with a stray space) would otherwise be sent upstream,
  // 400, and surface as a 502 outage — where an unconfigured show gets a clean
  // empty state. A config typo should look like the latter, not the former.
  return BEEHIIV_ID.test(normalized) ? normalized : undefined
}

// The podcasts live in one Beehiiv publication. `BEEHIIV_PUBLICATION_ID_PODCASTS`
// lets that be a different publication from the newsletter without touching the
// newsletter's own config; it falls back to the ark-daily publication, which is
// where they sit today.
function resolvePublicationId(env: Env): string | undefined {
  // `||`, not `??`: an env var that is present but blank (which is how both
  // Vite's loadEnv and Vercel represent "set to nothing") must fall through to
  // the newsletter publication, and `??` would return the empty string.
  const value =
    env.BEEHIIV_PUBLICATION_ID_PODCASTS?.trim() ||
    env.BEEHIIV_PUBLICATION_ID_ARK_DAILY?.trim()
  return value ? value : undefined
}

type BeehiivConfig = { publicationId: string; token: string }

function resolveConfig(env: Env): BeehiivConfig | null {
  const publicationId = resolvePublicationId(env)
  const token = env.BEEHIIV_API_KEY?.trim()
  if (!publicationId || !token) return null
  if (!BEEHIIV_ID.test(publicationId)) return null
  return { publicationId, token }
}

// --- Paid-audio gate -------------------------------------------------------
//
// A Beehiiv `audio_url` is a plain, unauthenticated MP3 link: whoever holds it
// can play the episode. So for a paid show these routes are the gate — the
// client-side Ark+ check on the episode page decides what to *render*, not who
// can *listen*. Metadata (title, date, description) stays public either way;
// only the audio url is withheld.
//
// Same shape as /api/beehiiv/posts: resolve entitlement from Neon, and keep a
// paid show's responses out of every shared cache — both the member body that
// carries the audio and the stripped body that doesn't, because they share a
// url and a shared cache cannot tell them apart.

type AudioAccess = { paid: boolean; allowed: boolean }

async function resolveAudioAccess(
  req: IncomingMessage,
  env: Env,
  showSlug: string,
): Promise<AudioAccess> {
  // Fail closed on a slug we don't know: an id configured for a show that
  // isn't in the catalog gets treated as gated rather than published.
  const paid = getShow(showSlug)?.paid ?? true
  if (!paid) return { paid: false, allowed: true }
  const resolved = await resolveMembership(req, env)
  return { paid: true, allowed: resolved?.entitlements.arkPlus ?? false }
}

/**
 * Read cache for the episode routes.
 *
 * Keyed on whether the SHOW is paid, not on whether this particular caller got
 * the audio. A paid show's url answers members and non-members with different
 * bodies, so no shared cache may hold either of them; a public show's url
 * answers everyone identically, so the edge is welcome to it.
 *
 * The `allowed` half of `access` deliberately plays no part here — see
 * setReadCacheControl for why reading it would reintroduce the bug.
 */
function setReadCache(
  res: ServerResponse,
  access: AudioAccess,
  maxAgeSec: number,
): void {
  setReadCacheControl(
    res,
    access.paid ? { gated: true } : { gated: false, maxAgeSec },
  )
}

function withAudioAccess<T extends { audioUrl: string }>(
  episode: T,
  access: AudioAccess,
): T {
  if (access.allowed) return episode
  return { ...episode, audioUrl: '' }
}

// Every Beehiiv call these routes make is now a small one — a single short
// page, one episode, or one show — so they all sit comfortably inside the
// default fetch budget. That is the point of paging the list: before it, the
// list alone needed 20s of headroom and the timeout had to be kept clear of
// `functions["api/handler.ts"].maxDuration` in vercel.json or it could never
// fire. Nothing here needs an override any more.
async function beehiivGet<T>(path: string, token: string): Promise<T> {
  const res = await fetchWithTimeout(
    `${BEEHIIV_API_BASE}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  )
  if (!res.ok) {
    throw new Error(`Beehiiv ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

// One page of the list. Kept separate from the cache/merge logic above so the
// "latest across shows" route can ask for a single short page of its own.
async function fetchEpisodePage(
  { publicationId, token }: BeehiivConfig,
  podcastId: string,
  page: number,
  pageSize: number = EPISODE_PAGE_SIZE,
): Promise<BeehiivEpisode[]> {
  // `status=published` filters upstream, but isPublishedEpisode still runs on
  // the merged result so the public site fails closed if the filter is ever
  // ignored.
  const query = new URLSearchParams({
    limit: String(pageSize),
    page: String(page),
    status: 'published',
    order_by: 'displayed_date',
    direction: 'desc',
  })
  const body = await beehiivGet<BeehiivListResponse>(
    `/publications/${encodeURIComponent(publicationId)}/podcasts/${encodeURIComponent(podcastId)}/episodes?${query}`,
    token,
  )
  return body.data ?? []
}

async function fetchEpisodes(
  { publicationId, token }: BeehiivConfig,
  podcastId: string,
  showSlug: string,
): Promise<EpisodeSummary[]> {
  // Every part of the cached value is derived from all three of these — the
  // fetch url from the first two, and `showSlug` from the projection, where it
  // becomes the episode links' route params. Keying on the podcast id alone
  // would serve one slug's episode links to another slug pointed at the same
  // Beehiiv show.
  const cacheKey = `${publicationId}:${podcastId}:${showSlug}`
  const cached = episodesCache.get(cacheKey)
  if (cached) return cached

  // Every page is its own request, so they all go out at once and the list
  // costs one page's latency rather than the whole catalogue's. A rejected page
  // rejects the lot — a partial list is worse than a retryable error, because
  // it would be cached and served as if it were complete.
  const pages = await Promise.all(
    Array.from({ length: EPISODE_PAGE_COUNT }, (_, i) =>
      fetchEpisodePage({ publicationId, token }, podcastId, i + 1),
    ),
  )

  const episodes: EpisodeSummary[] = dedupeById(pages.flat())
    .filter(isPublishedEpisode)
    .map((e) => projectBeehiivEpisodeSummary(e, showSlug))
    // `publishedAt` is a calendar date, so a show that drops twice in one day
    // ties — and a comparator that never returns 0 leaves the tied pair in
    // whatever order the sort happens to produce, which can differ between the
    // cached and freshly-fetched copies of the same list. Break the tie on the
    // (stable, unique) episode id so the order is the same every time.
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id),
    )

  episodesCache.set(cacheKey, episodes)
  return episodes
}

async function fetchEpisode(
  { publicationId, token }: BeehiivConfig,
  podcastId: string,
  showSlug: string,
  episodeId: string,
): Promise<ProjectedEpisode> {
  const cacheKey = `${publicationId}:${podcastId}:${showSlug}:${episodeId}`
  const cached = episodeCache.get(cacheKey)
  if (cached) return cached

  const body = await beehiivGet<{ data?: BeehiivEpisode }>(
    `/publications/${encodeURIComponent(publicationId)}/podcasts/${encodeURIComponent(podcastId)}/episodes/${encodeURIComponent(episodeId)}`,
    token,
  )
  const episode = projectBeehiivEpisode(body.data ?? {}, showSlug)
  episodeCache.set(cacheKey, episode)
  return episode
}

// The podcasts-page "latest episodes" strip: one newest episode per public
// show, not the newest N across the catalogue (which used to let a daily show
// fill every slot).
//
// Each show is asked for a single published episode. That is enough for the
// one-per-show rule and keeps the Beehiiv work to one short page per show
// instead of pulling every show's full list to throw most of it away.
async function fetchLatestEpisodes(
  config: BeehiivConfig,
  env: Env,
  limit: number,
): Promise<EpisodeSummary[]> {
  const cacheKey = `${config.publicationId}:one-per-show`
  const cached = latestCache.get(cacheKey)
  if (cached) return cached.slice(0, limit)

  // Public shows only. A paid show's audio is withheld from anyone who hasn't
  // proved membership, and this response is deliberately cacheable by a shared
  // edge for every caller — so the two must not meet. Filtering here (rather
  // than stripping audio later) also means an anonymous request never does an
  // entitlement lookup.
  const candidates = shows
    .filter((show) => !show.paid)
    .map((show) => ({ show, podcastId: resolvePodcastId(env, show.slug) }))
    .filter(
      (c): c is { show: (typeof shows)[number]; podcastId: string } =>
        c.podcastId !== undefined,
    )

  const perShow = await Promise.all(
    candidates.map(async ({ show, podcastId }) => {
      try {
        const page = await fetchEpisodePage(config, podcastId, 1, 1)
        const latest = page.filter(isPublishedEpisode)[0]
        return latest
          ? [projectBeehiivEpisodeSummary(latest, show.slug)]
          : []
      } catch (err) {
        // One show being unavailable shouldn't blank the strip — the other
        // shows still have episodes worth showing. Only a total failure
        // (handled by the caller, below) is worth an error state.
        console.error(`[beehiiv] latest fetch failed for ${show.slug}:`, err)
        return null
      }
    }),
  )

  // `every` is true for an empty array, so the length check matters: a server
  // with credentials but no BEEHIIV_PODCAST_ID_* set has nothing to fetch, and
  // that is an empty strip — the same clean empty state /api/podcasts/episodes
  // gives an unconfigured show — not an outage.
  if (candidates.length > 0 && perShow.every((r) => r === null)) {
    throw new Error('every show failed')
  }

  const episodes = perShow
    .flat()
    .filter((e): e is EpisodeSummary => e !== null)
    // Same tie-break as the per-show list: `publishedAt` is a calendar date, so
    // two shows dropping on the same day tie and need a stable second key.
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id),
    )

  latestCache.set(cacheKey, episodes)
  return episodes.slice(0, limit)
}

async function fetchShowDescription(
  { publicationId, token }: BeehiivConfig,
  podcastId: string,
): Promise<string> {
  const cached = showCache.get(podcastId)
  if (cached !== null) return cached

  const body = await beehiivGet<BeehiivShowResponse>(
    `/publications/${encodeURIComponent(publicationId)}/podcasts/${encodeURIComponent(podcastId)}`,
    token,
  )
  const description = stripHtml(body.data?.description ?? '')
  showCache.set(podcastId, description)
  return description
}

export function podcastRoutes({ env }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/podcasts/episodes',
      method: 'GET',
      handler: async (req, res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        if (!show) return json(400, { error: 'missing `show`' })

        const podcastId = resolvePodcastId(env, show)
        const config = resolveConfig(env)
        if (!podcastId || !config) {
          // Show has no Beehiiv podcast configured, or the server has no
          // credentials. Return an empty list — the client renders an empty
          // state rather than an error. Answered before the entitlement lookup
          // below: there is no audio in an empty list to gate, so an unknown
          // `show` can't make an anonymous request do membership work.
          setReadCache(res, { paid: false, allowed: true }, 300)
          return json(200, { episodes: [] })
        }

        const access = await resolveAudioAccess(req, env, show)
        setReadCache(res, access, 300)

        try {
          const episodes = await fetchEpisodes(config, podcastId, show)
          json(200, {
            episodes: episodes.map((e) => withAudioAccess(e, access)),
          })
        } catch (err) {
          console.error('[beehiiv] episodes fetch failed:', err)
          json(502, { error: 'podcasts_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/podcasts/latest',
      method: 'GET',
      handler: async (req, res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const raw = Number(url.searchParams.get('limit'))
        const limit = Number.isFinite(raw)
          ? Math.min(Math.max(Math.trunc(raw), 1), LATEST_MAX)
          : LATEST_DEFAULT

        // Public shows only, so the body is identical for every caller and a
        // shared edge can hold it. No entitlement lookup, no `Vary`.
        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=1800',
        )

        const config = resolveConfig(env)
        if (!config) {
          // No credentials (dev without a key). An empty strip renders as
          // nothing at all, which is the right podcasts page in that case.
          return json(200, { episodes: [] })
        }

        try {
          json(200, { episodes: await fetchLatestEpisodes(config, env, limit) })
        } catch (err) {
          console.error('[beehiiv] latest fetch failed:', err)
          json(502, { error: 'podcasts_unavailable' })
        }
      },
    }),
    defineRoute({
      // The only source of show notes, and the only route that will hand out a
      // paid show's audio url. The episode page reads both from here; the
      // israel-votes playlist resolves its curated audio here too.
      path: '/api/podcasts/episode',
      method: 'GET',
      handler: async (req, res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        const id = url.searchParams.get('id')
        if (!show) return json(400, { error: 'missing `show`' })
        if (!id) return json(400, { error: 'missing `id`' })
        if (!BEEHIIV_ID.test(id)) return json(400, { error: 'invalid `id`' })

        const podcastId = resolvePodcastId(env, show)
        const config = resolveConfig(env)
        if (!podcastId || !config) {
          setReadCache(res, { paid: false, allowed: true }, 900)
          return json(200, { episode: null })
        }

        const access = await resolveAudioAccess(req, env, show)
        setReadCache(res, access, 900)

        try {
          const episode = await fetchEpisode(config, podcastId, show, id)
          json(200, { episode: withAudioAccess(episode, access) })
        } catch (err) {
          console.error('[beehiiv] episode fetch failed:', err)
          json(502, { error: 'podcasts_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/podcasts/show',
      method: 'GET',
      handler: async (req, res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        if (!show) return json(400, { error: 'missing `show`' })

        // Show metadata carries no audio, so it is share-cacheable for every
        // caller regardless of membership.
        res.setHeader(
          'cache-control',
          'public, s-maxage=3600, stale-while-revalidate=86400',
        )

        const podcastId = resolvePodcastId(env, show)
        const config = resolveConfig(env)
        if (!podcastId || !config) {
          // Show has no Beehiiv podcast configured, or the server has no
          // credentials. Return an empty description — the client falls back
          // to the hand-written tagline.
          return json(200, { description: '' })
        }

        try {
          const description = await fetchShowDescription(config, podcastId)
          json(200, { description })
        } catch (err) {
          console.error('[beehiiv] show fetch failed:', err)
          json(502, { error: 'podcasts_unavailable' })
        }
      },
    }),
  ]
}
