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
import { fetchWithTimeout } from '../lib/http.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import { resolveMembership } from '../lib/entitlement-resolver.js'
import { getShow } from '../../src/data/shows.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

const BEEHIIV_API_BASE = 'https://api.beehiiv.com/v2'

// Beehiiv caps `limit` at 100, but its list endpoint is slow and its cost
// scales with the payload, so 100 episodes measured 7-16s. 50 keeps it to
// 4.5-7.6s and matches the page size Simplecast served. We take one page
// rather than walking `next_cursor` — these routes sit on the critical path
// for rendering a show page, so a second round-trip costs more than the tail
// of the back catalogue is worth.
const EPISODE_PAGE_LIMIT = 50

// Even at limit=50 the list endpoint runs to ~7.6s on our largest show, so the
// 8s default in fetchWithTimeout is not enough headroom. This is deliberately
// generous rather than unbounded: the in-process cache means a warm instance
// hits it once per show per 5 minutes, and the single-episode and show-metadata
// calls below are small, so they keep the default budget.
//
// The platform budget has to stay clear of this one or the timeout can never
// fire: Vercel would kill the invocation first and the caller would get an
// opaque 504 instead of the deliberate 502 below. `vercel.json` pins
// `functions["api/handler.ts"].maxDuration` above this for exactly that reason
// — move one and move the other.
const EPISODE_LIST_TIMEOUT_MS = 20_000

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

type BeehiivListResponse = { data?: BeehiivEpisode[] }
type BeehiivShowResponse = { data?: BeehiivPodcast }

/** Resets the process-global caches (unit tests only). */
export function clearPodcastCaches(): void {
  episodesCache.clear()
  episodeCache.clear()
  showCache.clear()
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
// Same shape as /api/beehiiv/posts: resolve entitlement from Neon, and mark
// the response `private, no-store` whenever it carries member-only content so
// a shared edge can never hand it to the next caller.

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

/** Public read cache. Skipped entirely when the body carries gated audio. */
function setReadCache(
  res: ServerResponse,
  access: AudioAccess,
  maxAgeSec: number,
): void {
  if (access.paid && access.allowed) {
    res.setHeader('cache-control', 'private, no-store')
    return
  }
  res.setHeader(
    'cache-control',
    `public, s-maxage=${maxAgeSec}, stale-while-revalidate=${maxAgeSec * 6}`,
  )
}

function withAudioAccess<T extends { audioUrl: string }>(
  episode: T,
  access: AudioAccess,
): T {
  if (access.allowed) return episode
  return { ...episode, audioUrl: '' }
}

async function beehiivGet<T>(
  path: string,
  token: string,
  timeoutMs?: number,
): Promise<T> {
  const res = await fetchWithTimeout(
    `${BEEHIIV_API_BASE}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    timeoutMs,
  )
  if (!res.ok) {
    throw new Error(`Beehiiv ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
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

  // `status=published` filters upstream, but isPublishedEpisode still runs so
  // the public site fails closed if the filter is ever ignored.
  const query = new URLSearchParams({
    limit: String(EPISODE_PAGE_LIMIT),
    status: 'published',
    order_by: 'displayed_date',
    direction: 'desc',
  })
  const body = await beehiivGet<BeehiivListResponse>(
    `/publications/${encodeURIComponent(publicationId)}/podcasts/${encodeURIComponent(podcastId)}/episodes?${query}`,
    token,
    EPISODE_LIST_TIMEOUT_MS,
  )
  const episodes: EpisodeSummary[] = (body.data ?? [])
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
