// Circle integration routes.
//
//   GET  /api/circle/community-events  — Admin v2 events → ArkEvent[] (strip).
//   GET  /api/circle/community-feed    — curated space posts → CommunityFeedItem[].
//   GET  /api/circle/spaces            — member-facing spaces → SuggestedSpace[].
//   GET  /api/circle/showcase          — PUBLIC: real posts → ShowcasePost[].
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
import {
  projectShowcasePost,
  selectShowcasePosts,
  SHOWCASE_SPACE_SLUGS,
  type CircleShowcasePost,
  type ShowcaseAuthor,
} from '../circle-showcase.js'
import type { ArkEvent } from '../../src/data/events.js'
import type {
  CommunityFeedItem,
  ShowcasePost,
  SuggestedSpace,
} from '../../shared/community.js'
import { resolveMembership } from '../lib/entitlement-resolver.js'
import { listCompanionCirclePostIds } from '../lib/discuss-threads.js'
import { getDb } from '../lib/db.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import type { IncomingMessage } from 'node:http'
import { fetchWithTimeout } from "../lib/http.js"

/**
 * Does the caller hold Circle access? The Fold lives on the `circle`
 * entitlement axis (Circle/Bundle), NOT arkPlus — gating it on arkPlus would
 * leak the Fold to Ark+-only members and false-lock the Circle-only members who
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
  circleShowcaseCache.clear()
  circleAuthorCache.clear()
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
// /fold subscriber feed — events, curated highlights, suggested spaces
//
// Same Admin v2 + paginate + project + cache pattern as above, but feeding the
// signed-in subscriber view on /fold. Projections live in
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
// INTERIM. The rebuilt Fold has eight spaces — announcements, ask-share,
// conversation, events, faqs, get-started, lounge, say-hi — and the one this
// pointed at (the old members-only content space) is not among them, so the
// feed had gone quietly empty. `conversation` is the closest fit until
// the Fold page is redesigned around the new spaces, at which point this
// is the line to change (or to replace with a multi-space aggregate).
//
// It is also the space DISCUSS_SPACE_BINDINGS posts newsletter companion
// threads into — the same rebuild pushed both there — so the highlights feed
// would otherwise fill with one auto-generated stub per article and show
// nothing else. Those posts are subtracted below by the ids we recorded when we
// created them; if this slug ever stops colliding with the discuss binding, the
// subtraction becomes a no-op rather than a thing to remember to remove.
const COMMUNITY_FEED_SPACE_SLUG = 'conversation'

// Companion-thread post ids, to keep our own machine-created stubs out of a
// feed that is meant to surface what members and the team actually wrote.
//
// Best-effort: no DATABASE_URL, or a Neon hiccup, degrades to an unfiltered
// feed and a logged line. A cluttered highlights feed beats no highlights feed.
async function companionThreadPostIds(env: Deps['env']): Promise<Set<string>> {
  if (!env.DATABASE_URL) return new Set()
  try {
    return new Set(await listCompanionCirclePostIds(getDb(env)))
  } catch (err) {
    console.error('[circle] companion thread ids unavailable, feed unfiltered:', err)
    return new Set()
  }
}

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
  env: Deps['env'],
): Promise<CommunityFeedItem[]> {
  const cached = circleCommunityFeedCache.get(COMMUNITY_FEED_SPACE_SLUG)
  if (cached) return cached

  const spaceId = await resolveSpaceIdBySlug(COMMUNITY_FEED_SPACE_SLUG, token)
  if (spaceId === null) {
    // Say so. A renamed or deleted space used to degrade to an empty feed with
    // no signal anywhere — which is exactly how this slug stayed stale through
    // a whole Fold rebuild.
    console.error(
      `[circle] community feed space "${COMMUNITY_FEED_SPACE_SLUG}" not found — feed is empty`,
    )
    return []
  }

  // Resolved before paging, not after: excluding afterwards would let the
  // companion threads eat into CIRCLE_SPACE_POSTS_TARGET and hand back a feed
  // shorter than the page it fills.
  const companions = await companionThreadPostIds(env)

  const matches: CircleFeedPost[] = []
  await paginateCircleAdmin<CircleFeedPost>(
    `posts?space_id=${spaceId}&status=published`,
    token,
    CIRCLE_SPACE_POSTS_PAGE_SIZE,
    CIRCLE_SPACE_POSTS_MAX_PAGES,
    (records) => {
      for (const p of records) {
        if (isPublishedFeedPost(p) && !companions.has(String(p.id))) {
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

// ---------------------------------------------------------------------------
// Public marketing showcase — real posts on the logged-out /fold page
//
// Same paginate + project + cache pattern, with two differences that matter:
// it is UNGATED (no callerHasCircleAccess), and it is therefore edge-cacheable
// rather than `private, no-store`. The narrowing that makes serving community
// content publicly acceptable lives in circle-showcase.ts — this file only
// promises to ask for allowlisted spaces and nothing else.
// ---------------------------------------------------------------------------

const circleShowcaseCache = makeTTLCache<string, ShowcasePost[]>(
  CIRCLE_CACHE_TTL_MS,
)
// Author profiles change far less often than posts, and the showcase re-reads
// the same handful of authors on every fill. Keyed by email, which is what
// Circle's member search accepts.
const circleAuthorCache = makeTTLCache<string, ShowcaseAuthor>(
  60 * 60 * 1000,
)

// Cards in the grid, and the most any one room may contribute (3 rooms x 2 =
// exactly the grid, so a balanced community fills it without backfill).
const SHOWCASE_LIMIT = 6
const SHOWCASE_PER_ROOM_CAP = 2
// Per space. The newest page is all the grid can use; older posts lose to
// recency in selectShowcasePosts anyway.
const SHOWCASE_POSTS_PAGE_SIZE = 25
const SHOWCASE_POSTS_MAX_PAGES = 1

/**
 * The author's city and avatar, by email. Circle has no lookup by user_id —
 * `community_members/search` takes an email, which posts carry.
 *
 * Best-effort by design: a 404 (member removed from the community) or any
 * other failure yields an empty profile, and the card simply renders without a
 * location. A missing city must never cost us the post.
 */
async function fetchShowcaseAuthor(
  email: string,
  token: string,
): Promise<ShowcaseAuthor> {
  const cached = circleAuthorCache.get(email)
  if (cached) return cached

  let author: ShowcaseAuthor = {}
  try {
    const res = await fetchWithTimeout(
      'https://app.circle.so/api/admin/v2/community_members/search' +
        `?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    )
    if (res.ok) {
      const body = (await res.json()) as {
        avatar_url?: string | null
        flattened_profile_fields?: { location?: string | null }
      }
      author = {
        location: body.flattened_profile_fields?.location ?? undefined,
        avatarUrl: body.avatar_url ?? undefined,
      }
    }
  } catch (err) {
    console.error(`[circle] showcase author lookup failed for ${email}:`, err)
  }

  circleAuthorCache.set(email, author)
  return author
}

async function fetchCircleShowcase(
  token: string,
  env: Deps['env'],
): Promise<ShowcasePost[]> {
  const cached = circleShowcaseCache.get('showcase')
  if (cached) return cached

  // Our own newsletter companion stubs are machine-written and would read as
  // community activity on a page selling community activity. Same subtraction
  // the member feed makes, same best-effort degradation.
  const companions = await companionThreadPostIds(env)

  const raw: CircleShowcasePost[] = []
  for (const slug of SHOWCASE_SPACE_SLUGS) {
    const spaceId = await resolveSpaceIdBySlug(slug, token)
    if (spaceId === null) {
      // Loud, not silent: a renamed space is exactly how the member feed went
      // quietly empty through a whole community rebuild.
      console.error(`[circle] showcase space "${slug}" not found — skipped`)
      continue
    }
    await paginateCircleAdmin<CircleShowcasePost>(
      `posts?space_id=${spaceId}&status=published`,
      token,
      SHOWCASE_POSTS_PAGE_SIZE,
      SHOWCASE_POSTS_MAX_PAGES,
      (records) => {
        for (const r of records) {
          if (!companions.has(String(r.id))) raw.push(r)
        }
      },
    )
  }

  // Two passes on purpose. The first projects without author detail, purely to
  // learn which six posts the grid will show; only then do we look up those
  // authors — six member lookups per fill instead of one per post fetched.
  const byId = new Map(raw.map((r) => [String(r.id), r]))
  const chosen = selectShowcasePosts(
    raw
      .map((r) => projectShowcasePost(r))
      .filter((p): p is ShowcasePost => p !== null),
    SHOWCASE_LIMIT,
    SHOWCASE_PER_ROOM_CAP,
  )

  const emails = [
    ...new Set(
      chosen
        .map((p) => byId.get(p.id)?.user_email?.trim())
        .filter((e): e is string => Boolean(e)),
    ),
  ]
  const authors = new Map<string, ShowcaseAuthor>(
    await Promise.all(
      emails.map(async (e) => [e, await fetchShowcaseAuthor(e, token)] as const),
    ),
  )

  // Second pass re-projects the chosen six with their author detail, in the
  // order the first pass settled on.
  const posts = chosen
    .map((p) => {
      const r = byId.get(p.id)
      if (!r) return p
      return projectShowcasePost(r, authors.get(r.user_email?.trim() ?? '') ?? {})
    })
    .filter((p): p is ShowcasePost => p !== null)

  circleShowcaseCache.set('showcase', posts)
  return posts
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
        // Fold content (the "Exclusive" space) — gated on the circle axis.
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
          const items = await fetchCircleCommunityFeed(token, env)
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
    defineRoute({
      path: '/api/circle/showcase',
      method: 'GET',
      handler: async (_req, res, json) => {
        // PUBLIC and identical for every visitor, so unlike its neighbours it
        // is edge-cacheable. SWR keeps a cold instance from making the page
        // wait on Circle.
        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=600',
        )

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { posts: [] })

        try {
          const posts = await fetchCircleShowcase(token, env)
          json(200, { posts })
        } catch (err) {
          // 200 + empty, not 502: this feeds one marketing section. The client
          // hides the section rather than showing the whole page an error.
          console.error('[circle] showcase fetch failed:', err)
          json(200, { posts: [] })
        }
      },
    }),
  ]
}
