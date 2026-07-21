// Circle integration routes.
//
//   GET  /api/circle/broadcasts        — "sent" broadcasts → NewsletterPosts.
//   GET  /api/circle/space-posts       — published space posts → NewsletterPosts.
//   GET  /api/circle/community-events  — Admin v2 events → ArkEvent[] (strip).
//   GET  /api/circle/community-feed    — curated space posts → CommunityFeedItem[].
//   GET  /api/circle/spaces            — member-facing spaces → SuggestedSpace[].
//
// Member sign-in into Circle is handled by Circle's own SSO (configured against
// our Auth0 tenant), not this server — deep links point straight at Circle URLs.

import {
  isSentBroadcast,
  projectBroadcast,
  type CircleBroadcast,
} from '../circle-broadcasts.js'
import {
  isPublishedPost,
  projectSpacePost,
  type CirclePost,
} from '../circle-space-posts.js'
import {
  isPublishedFeedPost,
  projectEvent,
  projectFeedPost,
  projectSpaces,
  type CircleEvent,
  type CircleFeedPost,
  type CircleSpace,
} from '../circle-community.js'
import type {
  NewsletterPost,
  NewsletterSlug,
} from '../../src/data/newsletters.js'
import type { ArkEvent } from '../../src/data/events.js'
import type { CommunityFeedItem, SuggestedSpace } from '../../shared/community.js'
import { makeJsonRes } from '../lib/http.js'
import { resolveMembership } from '../lib/entitlement-resolver.js'
import type { Deps, Route } from '../lib/route.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import { isNewsletterSlug } from './newsletter-slugs.js'
import type { IncomingMessage } from 'node:http'

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
const circleBroadcastsCache = makeTTLCache<NewsletterSlug, NewsletterPost[]>(
  CIRCLE_CACHE_TTL_MS,
)

// Test-only: drop in-process caches between cases so each test starts cold.
// Production code never calls this — the caches expire on their own TTL.
export function __resetCircleCachesForTests(): void {
  circleBroadcastsCache.clear()
  circleSpacePostsCache.clear()
  circleSpaceIdCache.clear()
  circleEventsCache.clear()
  circleCommunityFeedCache.clear()
  circleSpacesCache.clear()
}

// newsletter slug → { tag editors apply on send, author for the byline }
const CIRCLE_NEWSLETTER_BINDINGS: Partial<
  Record<NewsletterSlug, { tag: string; authorName: string }>
> = {}

// newsletter slug → { Circle space slug, author byline, tier the newsletter
// publishes at }. Space posts (community discussion content) don't carry a
// per-post tier signal like the "members-only" tag on broadcasts — every post
// in a gated space is gated, so the tier rides on the binding.
const CIRCLE_SPACE_BINDINGS: Partial<
  Record<
    NewsletterSlug,
    { spaceSlug: string; authorName: string; tier: 'free' | 'ark-plus' }
  >
> = {
  'members-letter': {
    spaceSlug: 'ark-code-of-conduct',
    authorName: 'Ark Media editorial',
    tier: 'ark-plus',
  },
}

// "Recent issues" target — we stop paging once we've collected this many
// tagged broadcasts. Tag-based broadcasts are uncommon enough that one or two
// pages usually suffice.
const CIRCLE_BROADCASTS_TARGET = 50
const CIRCLE_BROADCASTS_MAX_PAGES = 5
const CIRCLE_BROADCASTS_PAGE_SIZE = 50

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
    const res = await fetch(url, {
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

async function fetchCircleBroadcasts(
  newsletterSlug: NewsletterSlug,
  token: string,
): Promise<NewsletterPost[]> {
  const cached = circleBroadcastsCache.get(newsletterSlug)
  if (cached) return cached
  const binding = CIRCLE_NEWSLETTER_BINDINGS[newsletterSlug]
  if (!binding) return []

  // Page through Admin v2 broadcasts, filtering for the newsletter's tag
  // server-side. The Admin v2 API doesn't expose a `tag` query param, so we
  // still filter in-process — but we keep paging until we've collected
  // CIRCLE_BROADCASTS_TARGET hits (or run out of pages) instead of giving up
  // after the first 50 records regardless of tag distribution.
  const tagLc = binding.tag.toLowerCase()
  const matches: CircleBroadcast[] = []
  await paginateCircleAdmin<CircleBroadcast>(
    'broadcasts?status=sent',
    token,
    CIRCLE_BROADCASTS_PAGE_SIZE,
    CIRCLE_BROADCASTS_MAX_PAGES,
    (records) => {
      for (const b of records) {
        const tags = (b.tags ?? []).map((t) =>
          (typeof t === 'string' ? t : (t.name ?? '')).toLowerCase(),
        )
        if (tags.includes(tagLc) && isSentBroadcast(b)) {
          matches.push(b)
          if (matches.length >= CIRCLE_BROADCASTS_TARGET) return true
        }
      }
    },
  )

  const posts: NewsletterPost[] = matches
    .map((b) => projectBroadcast(b, newsletterSlug, binding.authorName))
    .filter((p): p is NewsletterPost => p !== null)
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        a.slug.localeCompare(b.slug),
    )

  circleBroadcastsCache.set(newsletterSlug, posts)
  return posts
}

// ---------------------------------------------------------------------------
// Circle space posts → NewsletterPost
//
// Admin v2 has no `slug` filter on /spaces, so we paginate /spaces, match the
// slug client-side, then fetch /posts?space_id=<id>. Both lookups are cached
// behind the same TTL as broadcasts.
// ---------------------------------------------------------------------------

const circleSpacePostsCache = makeTTLCache<NewsletterSlug, NewsletterPost[]>(
  CIRCLE_CACHE_TTL_MS,
)
const circleSpaceIdCache = makeTTLCache<string, number>(CIRCLE_CACHE_TTL_MS)

const CIRCLE_SPACES_PAGE_SIZE = 100
const CIRCLE_SPACES_MAX_PAGES = 5
const CIRCLE_SPACE_POSTS_TARGET = 50
const CIRCLE_SPACE_POSTS_MAX_PAGES = 5
const CIRCLE_SPACE_POSTS_PAGE_SIZE = 50

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

async function fetchCircleSpacePosts(
  newsletterSlug: NewsletterSlug,
  token: string,
): Promise<NewsletterPost[]> {
  const cached = circleSpacePostsCache.get(newsletterSlug)
  if (cached) return cached
  const binding = CIRCLE_SPACE_BINDINGS[newsletterSlug]
  if (!binding) return []

  const spaceId = await resolveSpaceIdBySlug(binding.spaceSlug, token)
  if (spaceId === null) return []

  const matches: CirclePost[] = []
  await paginateCircleAdmin<CirclePost>(
    `posts?space_id=${spaceId}&status=published`,
    token,
    CIRCLE_SPACE_POSTS_PAGE_SIZE,
    CIRCLE_SPACE_POSTS_MAX_PAGES,
    (records) => {
      for (const p of records) {
        // Belt-and-suspenders: the `status=published` query param filters
        // server-side, but Circle has historically returned drafts at the tail
        // of a page on some plans. Keep the projection guard so the local
        // assumption (only published reaches the wire) stays explicit.
        if (isPublishedPost(p)) {
          matches.push(p)
          if (matches.length >= CIRCLE_SPACE_POSTS_TARGET) return true
        }
      }
    },
  )

  const posts: NewsletterPost[] = matches
    .map((p) =>
      projectSpacePost(p, newsletterSlug, binding.authorName, binding.tier),
    )
    .filter((p): p is NewsletterPost => p !== null)
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        a.slug.localeCompare(b.slug),
    )

  circleSpacePostsCache.set(newsletterSlug, posts)
  return posts
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
const CIRCLE_EVENTS_MAX_PAGES = 3

// The space whose published posts power the curated highlights feed (decided
// with product). Resolved to a Circle space id via `resolveSpaceIdBySlug`.
const COMMUNITY_FEED_SPACE_SLUG = 'exclusive-ark-content'

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
  if (spaceId === null) return []

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
    {
      path: '/api/circle/broadcasts',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

        const url = new URL(req.url ?? '', 'http://x')
        const slug = url.searchParams.get('newsletter')
        if (!slug) return json(400, { error: 'missing `newsletter`' })
        if (!isNewsletterSlug(slug)) {
          return json(400, { error: 'invalid `newsletter`' })
        }

        // Broadcasts change on editorial cadence (hours/days). Vercel's
        // edge cache absorbs the traffic between cold starts via SWR.
        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=3600',
        )

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { posts: [] })

        try {
          const posts = await fetchCircleBroadcasts(slug, token)
          json(200, { posts })
        } catch (err) {
          console.error('[circle] broadcasts fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    },
    {
      path: '/api/circle/community-events',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

        // Events shift on editorial cadence; SWR absorbs traffic between cold
        // starts. The client re-derives live/upcoming from `starts_at` on each
        // 45s poll, so a short cache here doesn't delay the "live" flip.
        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=3600',
        )

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { events: [] })

        try {
          const events = await fetchCircleEvents(token)
          json(200, { events })
        } catch (err) {
          console.error('[circle] events fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    },
    {
      path: '/api/circle/community-feed',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

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
    },
    {
      path: '/api/circle/spaces',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=3600',
        )

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { spaces: [] })

        try {
          const spaces = await fetchMemberSpaces(token)
          json(200, { spaces })
        } catch (err) {
          console.error('[circle] spaces fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    },
    {
      path: '/api/circle/space-posts',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

        const url = new URL(req.url ?? '', 'http://x')
        const slug = url.searchParams.get('newsletter')
        if (!slug) return json(400, { error: 'missing `newsletter`' })
        if (!isNewsletterSlug(slug)) {
          return json(400, { error: 'invalid `newsletter`' })
        }

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { posts: [] })

        // A gated (ark-plus) space must not ship post bodies to non-members:
        // projectSpacePost stamps the full sanitized bodyHtml regardless of who
        // asks. Gate on the circle axis like community-feed — withhold body/
        // bodyHtml for non-members (metadata still ships so the client renders a
        // locked teaser + CTA) and mark the response private so no shared cache
        // holds identity-scoped premium HTML. Free spaces stay publicly cached.
        const gated = CIRCLE_SPACE_BINDINGS[slug]?.tier === 'ark-plus'
        const hasAccess = gated ? await callerHasCircleAccess(req, env) : true
        res.setHeader(
          'cache-control',
          gated
            ? 'private, no-store'
            : 'public, s-maxage=300, stale-while-revalidate=3600',
        )

        try {
          const posts = await fetchCircleSpacePosts(slug, token)
          const safe = hasAccess
            ? posts
            : posts.map((p) => ({ ...p, body: '', bodyHtml: '' }))
          json(200, { posts: safe })
        } catch (err) {
          console.error('[circle] space posts fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    },
  ]
}
