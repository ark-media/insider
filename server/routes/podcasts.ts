// Beehiiv episode catalog.
//
// Proxies the Beehiiv Podcasts API and projects the response down to our
// Episode shape. Three routes:
//
//   GET /api/podcasts/episodes — list. Full summaries, including show notes.
//   GET /api/podcasts/episode  — single episode with show notes html.
//   GET /api/podcasts/show     — show-level metadata (description).
//
// All three are cached in-process. The cache resets on each serverless cold
// start, which is fine — Beehiiv updates on the order of days, not seconds.
//
// The API token can't ride along with the client, so every one of these is a
// server-side proxy. Beehiiv nests podcasts under a publication:
//   /v2/publications/{publicationId}/podcasts/{podcastShowId}/episodes

import {
  isPublishedEpisode,
  projectBeehiivEpisode,
  sanitizeShowNotes,
  stripHtml,
  type BeehiivEpisode,
  type BeehiivPodcast,
  type ProjectedEpisode,
} from '../show-notes.js'
import { defineRoute, type Deps, type Env, type Route } from '../lib/route.js'
import { fetchWithTimeout } from '../lib/http.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'

const BEEHIIV_API_BASE = 'https://api.beehiiv.com/v2'

// Beehiiv caps `limit` at 100, but its list endpoint is slow and its cost
// scales with the payload: every episode carries full `show_notes` HTML plus a
// copy of the whole nested show object, so 100 episodes is ~600KB and measured
// 7-16s. 50 keeps it to ~250KB / 4.5-7.6s and matches the page size Simplecast
// served. We take one page rather than walking `next_cursor` — these routes sit
// on the critical path for rendering a show page, so a second round-trip costs
// more than the tail of the back catalogue is worth.
const EPISODE_PAGE_LIMIT = 50

// Even at limit=50 the list endpoint runs to ~7.6s on our largest show, so the
// 8s default in fetchWithTimeout is not enough headroom. This is deliberately
// generous rather than unbounded: the in-process cache means a warm instance
// hits it once per show per 5 minutes, and the single-episode and show-metadata
// calls below are small, so they keep the default budget.
const EPISODE_LIST_TIMEOUT_MS = 20_000

const EPISODES_CACHE_TTL_MS = 5 * 60 * 1000
const episodesCache = makeTTLCache<string, ProjectedEpisode[]>(
  EPISODES_CACHE_TTL_MS,
)

// Show notes change rarely, so the per-episode fetch is cached longer than the
// list. Beehiiv returns `show_notes` on the list endpoint too, so this is now
// only a fallback for episodes outside the first page — Simplecast's slim list
// used to make it mandatory.
const EPISODE_CACHE_TTL_MS = 30 * 60 * 1000
type EpisodeNotes = { showNotesHtml: string; description: string }
const episodeCache = makeTTLCache<string, EpisodeNotes>(EPISODE_CACHE_TTL_MS)

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
  return value.startsWith('pod_') ? value : `pod_${value}`
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
): Promise<ProjectedEpisode[]> {
  const cached = episodesCache.get(podcastId)
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
  const episodes: ProjectedEpisode[] = (body.data ?? [])
    .filter(isPublishedEpisode)
    .map((e) => projectBeehiivEpisode(e, showSlug))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))

  episodesCache.set(podcastId, episodes)
  return episodes
}

async function fetchEpisodeNotes(
  { publicationId, token }: BeehiivConfig,
  podcastId: string,
  episodeId: string,
): Promise<EpisodeNotes> {
  const cacheKey = `${podcastId}:${episodeId}`
  const cached = episodeCache.get(cacheKey)
  if (cached) return cached

  const body = await beehiivGet<{ data?: BeehiivEpisode }>(
    `/publications/${encodeURIComponent(publicationId)}/podcasts/${encodeURIComponent(podcastId)}/episodes/${encodeURIComponent(episodeId)}`,
    token,
  )
  const episode = body.data ?? {}
  const rawNotes = episode.show_notes ?? episode.description ?? ''
  const notes: EpisodeNotes = {
    showNotesHtml: sanitizeShowNotes(rawNotes),
    description: stripHtml(episode.description ?? ''),
  }
  episodeCache.set(cacheKey, notes)
  return notes
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
      handler: async (req, _res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        if (!show) return json(400, { error: 'missing `show`' })

        const podcastId = resolvePodcastId(env, show)
        const config = resolveConfig(env)
        if (!podcastId || !config) {
          // Show has no Beehiiv podcast configured, or the server has no
          // credentials. Return an empty list — the client renders an empty
          // state rather than an error.
          return json(200, { episodes: [] })
        }

        try {
          const episodes = await fetchEpisodes(config, podcastId, show)
          json(200, { episodes })
        } catch (err) {
          console.error('[beehiiv] episodes fetch failed:', err)
          json(502, { error: 'podcasts_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/podcasts/episode',
      method: 'GET',
      handler: async (req, _res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        const id = url.searchParams.get('id')
        if (!show) return json(400, { error: 'missing `show`' })
        if (!id) return json(400, { error: 'missing `id`' })
        if (!BEEHIIV_ID.test(id)) return json(400, { error: 'invalid `id`' })

        const podcastId = resolvePodcastId(env, show)
        const config = resolveConfig(env)
        if (!podcastId || !config) {
          return json(200, { showNotesHtml: '', description: '' })
        }

        try {
          const notes = await fetchEpisodeNotes(config, podcastId, id)
          json(200, notes)
        } catch (err) {
          console.error('[beehiiv] episode fetch failed:', err)
          json(502, { error: 'podcasts_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/podcasts/show',
      method: 'GET',
      handler: async (req, _res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        if (!show) return json(400, { error: 'missing `show`' })

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
