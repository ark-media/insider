// Simplecast episode catalog.
//
// Proxies the Simplecast Episodes API and projects the response down to our
// Episode shape. Two routes:
//
//   GET /api/simplecast/episodes — list. Slim summaries; no show notes.
//   GET /api/simplecast/episode  — single episode with show notes html.
//   GET /api/simplecast/podcast  — show-level metadata (description).
//
// Both are cached in-process. The cache resets on each serverless cold
// start, which is fine — Simplecast updates on the order of days, not
// seconds.

import {
  isPublishedEpisode,
  projectScEpisode,
  sanitizeShowNotes,
  stripHtml,
  type ProjectedEpisode,
  type ScEpisode,
} from '../show-notes.js'
import type { ScPodcast } from '../show-notes.js'
import { defineRoute, type Deps, type Env, type Route } from '../lib/route.js'

const SIMPLECAST_CACHE_TTL_MS = 5 * 60 * 1000
const simplecastCache = new Map<
  string,
  { at: number; episodes: ProjectedEpisode[] }
>()

// Per-episode cache for the full episode fetch. The list endpoint
// (`/podcasts/{id}/episodes`) returns slim summaries that omit both
// `description` and `long_description`, so the only way to get show notes is
// `/episodes/{id}`. Cached longer than the list — show notes change rarely.
const SIMPLECAST_EPISODE_CACHE_TTL_MS = 30 * 60 * 1000
type EpisodeNotes = { showNotesHtml: string; description: string }
const simplecastEpisodeCache = new Map<
  string,
  { at: number; notes: EpisodeNotes }
>()

// Show-level metadata (title, description) changes very rarely — on the order
// of months — so it gets a much longer TTL than episodes or show notes. The
// cache still resets on each serverless cold start, bounding staleness.
const SIMPLECAST_PODCAST_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const simplecastPodcastCache = new Map<
  string,
  { at: number; description: string }
>()

type ScEpisodesResponse = { collection?: ScEpisode[] }

function resolveSimplecastPodcastId(env: Env, showSlug: string): string | undefined {
  // Accept only the slug pattern we expect so a caller can't probe arbitrary
  // env keys by injecting an unusual `show` value.
  if (!/^[a-z0-9-]+$/.test(showSlug)) return undefined
  const key = `VITE_SIMPLECAST_PODCAST_ID_${showSlug.toUpperCase().replace(/-/g, '_')}`
  const value = env[key]
  return value && value.trim() ? value.trim() : undefined
}

async function fetchSimplecastEpisodes(
  podcastId: string,
  token: string,
  showSlug: string,
): Promise<ProjectedEpisode[]> {
  const cached = simplecastCache.get(podcastId)
  if (cached && Date.now() - cached.at < SIMPLECAST_CACHE_TTL_MS) {
    return cached.episodes
  }

  const url = `https://api.simplecast.com/podcasts/${encodeURIComponent(podcastId)}/episodes?limit=50`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Simplecast ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as ScEpisodesResponse
  const episodes: ProjectedEpisode[] = (body.collection ?? [])
    .filter(isPublishedEpisode)
    .map((e) => projectScEpisode(e, showSlug))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))

  simplecastCache.set(podcastId, { at: Date.now(), episodes })
  return episodes
}

async function fetchSimplecastEpisodeNotes(
  episodeId: string,
  token: string,
): Promise<EpisodeNotes> {
  const cached = simplecastEpisodeCache.get(episodeId)
  if (cached && Date.now() - cached.at < SIMPLECAST_EPISODE_CACHE_TTL_MS) {
    return cached.notes
  }
  const url = `https://api.simplecast.com/episodes/${encodeURIComponent(episodeId)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Simplecast ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as ScEpisode
  const rawNotes = body.long_description ?? body.description ?? ''
  const notes: EpisodeNotes = {
    showNotesHtml: sanitizeShowNotes(rawNotes),
    description: stripHtml(body.description ?? ''),
  }
  simplecastEpisodeCache.set(episodeId, { at: Date.now(), notes })
  return notes
}

async function fetchSimplecastPodcastDescription(
  podcastId: string,
  token: string,
): Promise<string> {
  const cached = simplecastPodcastCache.get(podcastId)
  if (cached && Date.now() - cached.at < SIMPLECAST_PODCAST_CACHE_TTL_MS) {
    return cached.description
  }
  const url = `https://api.simplecast.com/podcasts/${encodeURIComponent(podcastId)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Simplecast ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as ScPodcast
  const description = stripHtml(body.description ?? '')
  simplecastPodcastCache.set(podcastId, { at: Date.now(), description })
  return description
}

export function simplecastRoutes({ env }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/simplecast/episodes',
      method: 'GET',
      handler: async (req, _res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        if (!show) return json(400, { error: 'missing `show`' })

        const podcastId = resolveSimplecastPodcastId(env, show)
        const token = env.SIMPLECAST_API_TOKEN
        if (!podcastId || !token) {
          // Show has no Simplecast podcast configured, or the server has no
          // token. Return an empty list — the client falls back to mocks.
          return json(200, { episodes: [] })
        }

        try {
          const episodes = await fetchSimplecastEpisodes(podcastId, token, show)
          json(200, { episodes })
        } catch (err) {
          console.error('[simplecast] fetch failed:', err)
          json(502, { error: 'simplecast_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/simplecast/episode',
      method: 'GET',
      handler: async (req, _res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const id = url.searchParams.get('id')
        if (!id) return json(400, { error: 'missing `id`' })
        // UUID format check — the id is interpolated into the upstream URL.
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
          return json(400, { error: 'invalid `id`' })
        }

        const token = env.SIMPLECAST_API_TOKEN
        if (!token) return json(200, { showNotesHtml: '', description: '' })

        try {
          const notes = await fetchSimplecastEpisodeNotes(id, token)
          json(200, notes)
        } catch (err) {
          console.error('[simplecast] episode fetch failed:', err)
          json(502, { error: 'simplecast_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/simplecast/podcast',
      method: 'GET',
      handler: async (req, _res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const show = url.searchParams.get('show')
        if (!show) return json(400, { error: 'missing `show`' })

        const podcastId = resolveSimplecastPodcastId(env, show)
        const token = env.SIMPLECAST_API_TOKEN
        if (!podcastId || !token) {
          // Show has no Simplecast podcast configured, or the server has no
          // token. Return an empty description — the client falls back to the
          // hand-written tagline.
          return json(200, { description: '' })
        }

        try {
          const description = await fetchSimplecastPodcastDescription(podcastId, token)
          json(200, { description })
        } catch (err) {
          console.error('[simplecast] podcast fetch failed:', err)
          json(502, { error: 'simplecast_unavailable' })
        }
      },
    }),
  ]
}
