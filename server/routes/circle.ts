// Circle integration routes.
//
//   GET  /api/circle/community-events  — Admin v2 events → ArkEvent[] (strip).
//   GET  /api/circle/community-feed    — curated space posts → CommunityFeedItem[].
//   GET  /api/circle/spaces            — member-facing spaces → SuggestedSpace[].
//
// Member sign-in into Circle is handled by Circle's own SSO (configured against
// our Auth0 tenant), not this server — deep links point straight at Circle URLs.

import {
  isPublishedFeedPost,
  projectEvent,
  projectFeedPost,
  projectSpaces,
  type CircleEvent,
  type CircleFeedPost,
  type CircleSpace,
} from '../circle-community.js'
import type { ArkEvent } from '../../src/data/events.js'
import type { CommunityFeedItem, SuggestedSpace } from '../../shared/community.js'
import { resolveMembership } from '../lib/entitlement-resolver.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import type { IncomingMessage } from 'node:http'
import { fetchWithTimeout } from "../lib/http.js"

/**
 * Does the caller hold Circle access? The community lives on the `circle`
 * entitlement axis (Circle/Bundle), NOT arkPlus — gating it on arkPlus would
 * leak community to Ark+-only members and false-lock the Circle-only members who
 * paid for it (§3 risk 5). Resolved from Neon (the authority); guests → false.
 */
async function callerHasCircleAccess(
  req: IncomingMessage,
  env: Deps['env'],
): Promise<boolean> {
  const resolved = await resolveMembership(req, env)
  return resolved?.entitlements.circle ?? false
}

const CIRCLE_CACHE_TTL_MS = 5 * 60 * 1000

// Test-only: drop in-process caches between cases so each test starts cold.
// Production code never calls this — the caches expire on their own TTL.
export function __resetCircleCachesForTests(): void {
  circleSpaceIdCache.clear()
  circleEventsCache.clear()
  circleCommunityFeedCache.clear()
  circleSpacesCache.clear()
}

// Shared Admin v2 pagination. Walks pages of
// `https://app.circle.so/api/admin/v2/<path>` (appending per_page/page),
// throws on a non-2xx, and hands each page's `records` to `onPage`. Stops when:
// the page is empty, `onPage` returns true (target hit / match found), the API
// reports `has_next_page: false`, or a short page signals the end. Callers own
// filtering/projection/accumulation; this owns the HTTP + loop invariants that
// were previously copy-pasted across every fetcher below.
async function paginateCircleAdmin<R>(
  path: string,
  token: string,
  pageSize: number,
  maxPages: number,
  onPage: (records: R[]) => boolean | void,
): Promise<void> {
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const url =
      `https://app.circle.so/api/admin/v2/${path}${sep}` +
      `per_page=${pageSize}&page=${page}`
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Circle ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { records?: R[]; has_next_page?: boolean }
    const records = body.records ?? []
    if (records.length === 0) break
    if (onPage(records) === true) break
    if (body.has_next_page === false) break
    if (records.length < pageSize) break
  }
}

const circleSpaceIdCache = makeTTLCache<string, number>(CIRCLE_CACHE_TTL_MS)

const CIRCLE_SPACES_PAGE_SIZE = 100
const CIRCLE_SPACES_MAX_PAGES = 5

type CircleSpaceRecord = { id?: number; slug?: string }

async function resolveSpaceIdBySlug(
  spaceSlug: string,
  token: string,
): Promise<number | null> {
  const cached = circleSpaceIdCache.get(spaceSlug)
  if (cached !== null) return cached
  let foundId: number | null = null
  await paginateCircleAdmin<CircleSpaceRecord>(
    'spaces',
    token,
    CIRCLE_SPACES_PAGE_SIZE,
    CIRCLE_SPACES_MAX_PAGES,
    (records) => {
      const match = records.find((s) => s.slug === spaceSlug)
      if (match?.id !== undefined) {
        foundId = match.id
        return true
      }
    },
  )
  if (foundId !== null) {
    circleSpaceIdCache.set(spaceSlug, foundId)
    return foundId
  }
  return null
}

// ---------------------------------------------------------------------------
// /community subscriber feed — events, curated highlights, suggested spaces
//
// Same Admin v2 + paginate + project + cache pattern as above, but feeding the
// signed-in subscriber view on /community. Projections live in
// circle-community.ts; this file owns the HTTP/pagination/caching.
// ---------------------------------------------------------------------------

const circleEventsCache = makeTTLCache<string, ArkEvent[]>(CIRCLE_CACHE_TTL_MS)
const circleCommunityFeedCache = makeTTLCache<string, CommunityFeedItem[]>(
  CIRCLE_CACHE_TTL_MS,
)
const circleSpacesCache = makeTTLCache<string, SuggestedSpace[]>(
  CIRCLE_CACHE_TTL_MS,
)

const CIRCLE_EVENTS_PAGE_SIZE = 100
// Paging budget for /posts?space_id=… — the curated highlights feed stops
// once it has this many published posts.
const CIRCLE_SPACE_POSTS_PAGE_SIZE = 50
const CIRCLE_SPACE_POSTS_MAX_PAGES = 5
const CIRCLE_SPACE_POSTS_TARGET = 50
const CIRCLE_EVENTS_MAX_PAGES = 3

// The space whose published posts power the curated highlights feed. Resolved
// to a Circle space id via `resolveSpaceIdBySlug`.
//
// INTERIM. The rebuilt community has eight spaces — announcements, ask-share,
// conversation, events, faqs, get-started, lounge, say-hi — and the one this
// pointed at (the old members-only content space) is not among them, so the
// feed had gone quietly empty. `conversation` is the closest fit until
// the community page is redesigned around the new spaces, at which point this
// is the line to change (or to replace with a multi-space aggregate).
const COMMUNITY_FEED_SPACE_SLUG = 'conversation'

async function fetchCircleEvents(token: string): Promise<ArkEvent[]> {
  const cached = circleEventsCache.get('events')
  if (cached) return cached

  const out: ArkEvent[] = []
  await paginateCircleAdmin<CircleEvent>(
    'events',
    token,
    CIRCLE_EVENTS_PAGE_SIZE,
    CIRCLE_EVENTS_MAX_PAGES,
    (records) => {
      for (const r of records) {
        const ev = projectEvent(r)
        if (ev) out.push(ev)
      }
    },
  )

  circleEventsCache.set('events', out)
  return out
}

async function fetchCircleCommunityFeed(
  token: string,
): Promise<CommunityFeedItem[]> {
  const cached = circleCommunityFeedCache.get(COMMUNITY_FEED_SPACE_SLUG)
  if (cached) return cached

  const spaceId = await resolveSpaceIdBySlug(COMMUNITY_FEED_SPACE_SLUG, token)
  if (spaceId === null) {
    // Say so. A renamed or deleted space used to degrade to an empty feed with
    // no signal anywhere — which is exactly how this slug stayed stale through
    // a whole community rebuild.
    console.error(
      `[circle] community feed space "${COMMUNITY_FEED_SPACE_SLUG}" not found — feed is empty`,
    )
    return []
  }

  const matches: CircleFeedPost[] = []
  await paginateCircleAdmin<CircleFeedPost>(
    `posts?space_id=${spaceId}&status=published`,
    token,
    CIRCLE_SPACE_POSTS_PAGE_SIZE,
    CIRCLE_SPACE_POSTS_MAX_PAGES,
    (records) => {
      for (const p of records) {
        if (isPublishedFeedPost(p)) {
          matches.push(p)
          if (matches.length >= CIRCLE_SPACE_POSTS_TARGET) return true
        }
      }
    },
  )

  const items: CommunityFeedItem[] = matches
    .map((p) => projectFeedPost(p))
    .filter((p): p is CommunityFeedItem => p !== null)
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id),
    )

  circleCommunityFeedCache.set(COMMUNITY_FEED_SPACE_SLUG, items)
  return items
}

async function fetchMemberSpaces(token: string): Promise<SuggestedSpace[]> {
  const cached = circleSpacesCache.get('spaces')
  if (cached) return cached

  const all: CircleSpace[] = []
  await paginateCircleAdmin<CircleSpace>(
    'spaces',
    token,
    CIRCLE_SPACES_PAGE_SIZE,
    CIRCLE_SPACES_MAX_PAGES,
    (records) => {
      all.push(...records)
    },
  )

  const spaces = projectSpaces(all)
  circleSpacesCache.set('spaces', spaces)
  return spaces
}

export function circleRoutes({ env }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/circle/community-events',
      method: 'GET',
      handler: async (req, res, json) => {
        // Member-only calendar — projectEvent ships `venue`, the physical
        // address of in-person events. Identity-scoped, so it must never sit in
        // a shared cache: one anonymous fill would then be served to members
        // (and vice versa). Gated like community-feed.
        res.setHeader('cache-control', 'private, no-store')

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { events: [] })

        // Empty rather than 403 so the client renders the real empty state
        // instead of a mock fallback — same contract as community-feed.
        if (!(await callerHasCircleAccess(req, env))) {
          return json(200, { events: [] })
        }

        try {
          const events = await fetchCircleEvents(token)
          json(200, { events })
        } catch (err) {
          console.error('[circle] events fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/circle/community-feed',
      method: 'GET',
      handler: async (req, res, json) => {
        // Community content (the "Exclusive" space) — gated on the circle axis.
        // Never let a shared cache hold it; the response is identity-scoped.
        res.setHeader('cache-control', 'private, no-store')

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { items: [] })

        // Withhold from non-Circle members (returns empty rather than 403 so the
        // client renders the real empty state, not a mock fallback).
        if (!(await callerHasCircleAccess(req, env))) {
          return json(200, { items: [] })
        }

        try {
          const items = await fetchCircleCommunityFeed(token)
          json(200, { items })
        } catch (err) {
          console.error('[circle] community feed fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    }),
    defineRoute({
      path: '/api/circle/spaces',
      method: 'GET',
      handler: async (req, res, json) => {
        // The member space directory — same gating and cache contract as
        // community-events above.
        res.setHeader('cache-control', 'private, no-store')

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { spaces: [] })

        if (!(await callerHasCircleAccess(req, env))) {
          return json(200, { spaces: [] })
        }

        try {
          const spaces = await fetchMemberSpaces(token)
          json(200, { spaces })
        } catch (err) {
          console.error('[circle] spaces fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    }),
  ]
}
