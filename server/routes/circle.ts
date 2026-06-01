// Circle integration routes.
//
//   GET  /api/circle/broadcasts        — "sent" broadcasts → NewsletterPosts.
//   GET  /api/circle/space-posts       — published space posts → NewsletterPosts.
//   GET  /api/circle/community-events  — Admin v2 events → ArkEvent[] (strip).
//   GET  /api/circle/community-feed    — curated space posts → CommunityFeedItem[].
//   GET  /api/circle/spaces            — member-facing spaces → SuggestedSpace[].
//   POST /api/circle-sso               — mints a signed JWT so an authenticated
//     subscriber can SSO into Circle without a second login.

import { SignJWT } from 'jose'
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
import { fetchAuth0EmailVerified, fetchAuth0TierForEmail } from '../entitlement.js'
import { CHECKOUT_COOKIE_NAME, readCookie } from '../lib/cookies.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import {
  verifyAuth0BearerProfile,
  verifyCheckoutToken,
} from '../lib/session.js'
import type { Deps, Route } from '../lib/route.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import { isNewsletterSlug } from './newsletter-slugs.js'
import type { IncomingMessage } from 'node:http'

/**
 * Is the caller an authenticated Ark+ member? Mirrors the tier resolution in
 * /api/circle-sso: a verified Auth0 bearer (tier claim, with a Management API
 * fallback when the claim is absent) or the post-checkout session cookie
 * (always paid). Guests resolve to false. Used to gate member-only content.
 */
async function callerIsArkPlusMember(
  req: IncomingMessage,
  env: Deps['env'],
): Promise<boolean> {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const profile = await verifyAuth0BearerProfile(token)
    if (profile) {
      if (profile.tier) return profile.tier === 'ark-plus-member'
      // Tier claim absent (Action not deployed yet) — authoritative lookup.
      return (await fetchAuth0TierForEmail(env, profile.email)) === 'ark-plus-member'
    }
    // Older clients may pass the checkout-session token as a bearer.
    if (await verifyCheckoutToken(token, env)) return true
  }
  const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
  if (cookieToken) return Boolean(await verifyCheckoutToken(cookieToken, env))
  return false
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
  for (let page = 1; page <= CIRCLE_BROADCASTS_MAX_PAGES; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/broadcasts` +
      `?status=sent&per_page=${CIRCLE_BROADCASTS_PAGE_SIZE}&page=${page}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Circle ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { records?: CircleBroadcast[] }
    const records = body.records ?? []
    if (records.length === 0) break
    for (const b of records) {
      const tags = (b.tags ?? []).map((t) =>
        (typeof t === 'string' ? t : (t.name ?? '')).toLowerCase(),
      )
      if (tags.includes(tagLc) && isSentBroadcast(b)) {
        matches.push(b)
        if (matches.length >= CIRCLE_BROADCASTS_TARGET) break
      }
    }
    if (matches.length >= CIRCLE_BROADCASTS_TARGET) break
    if (records.length < CIRCLE_BROADCASTS_PAGE_SIZE) break
  }

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
  for (let page = 1; page <= CIRCLE_SPACES_MAX_PAGES; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/spaces` +
      `?per_page=${CIRCLE_SPACES_PAGE_SIZE}&page=${page}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Circle ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { records?: CircleSpaceRecord[] }
    const records = body.records ?? []
    if (records.length === 0) break
    const match = records.find((s) => s.slug === spaceSlug)
    if (match?.id !== undefined) {
      circleSpaceIdCache.set(spaceSlug, match.id)
      return match.id
    }
    if (records.length < CIRCLE_SPACES_PAGE_SIZE) break
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
  for (let page = 1; page <= CIRCLE_SPACE_POSTS_MAX_PAGES; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/posts` +
      `?space_id=${spaceId}` +
      `&status=published` +
      `&per_page=${CIRCLE_SPACE_POSTS_PAGE_SIZE}&page=${page}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Circle ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { records?: CirclePost[] }
    const records = body.records ?? []
    if (records.length === 0) break
    for (const p of records) {
      // Belt-and-suspenders: the `status=published` query param above filters
      // server-side, but Circle has historically returned drafts at the tail
      // of a page on some plans. Keep the projection guard so the local
      // assumption (only published reaches the wire) stays explicit.
      if (isPublishedPost(p)) {
        matches.push(p)
        if (matches.length >= CIRCLE_SPACE_POSTS_TARGET) break
      }
    }
    if (matches.length >= CIRCLE_SPACE_POSTS_TARGET) break
    if (records.length < CIRCLE_SPACE_POSTS_PAGE_SIZE) break
  }

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
  for (let page = 1; page <= CIRCLE_EVENTS_MAX_PAGES; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/events` +
      `?per_page=${CIRCLE_EVENTS_PAGE_SIZE}&page=${page}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Circle ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as {
      records?: CircleEvent[]
      has_next_page?: boolean
    }
    const records = body.records ?? []
    if (records.length === 0) break
    for (const r of records) {
      const ev = projectEvent(r)
      if (ev) out.push(ev)
    }
    if (body.has_next_page === false) break
    if (records.length < CIRCLE_EVENTS_PAGE_SIZE) break
  }

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
  for (let page = 1; page <= CIRCLE_SPACE_POSTS_MAX_PAGES; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/posts` +
      `?space_id=${spaceId}` +
      `&status=published` +
      `&per_page=${CIRCLE_SPACE_POSTS_PAGE_SIZE}&page=${page}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Circle ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { records?: CircleFeedPost[] }
    const records = body.records ?? []
    if (records.length === 0) break
    for (const p of records) {
      if (isPublishedFeedPost(p)) {
        matches.push(p)
        if (matches.length >= CIRCLE_SPACE_POSTS_TARGET) break
      }
    }
    if (matches.length >= CIRCLE_SPACE_POSTS_TARGET) break
    if (records.length < CIRCLE_SPACE_POSTS_PAGE_SIZE) break
  }

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
  for (let page = 1; page <= CIRCLE_SPACES_MAX_PAGES; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/spaces` +
      `?per_page=${CIRCLE_SPACES_PAGE_SIZE}&page=${page}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Circle ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { records?: CircleSpace[] }
    const records = body.records ?? []
    if (records.length === 0) break
    all.push(...records)
    if (records.length < CIRCLE_SPACES_PAGE_SIZE) break
  }

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

        // Member-only content (the Ark+ "Exclusive" space). Gate on a verified
        // subscriber and never let a shared cache hold it — the response is
        // identity-scoped, not public.
        res.setHeader('cache-control', 'private, no-store')

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { items: [] })

        // Withhold the content from non-subscribers (returns empty rather than
        // 403 so the client renders the real empty state, not a mock fallback).
        if (!(await callerIsArkPlusMember(req, env))) {
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

        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=3600',
        )

        const token = env.CIRCLE_ADMIN_API_TOKEN
        if (!token) return json(200, { posts: [] })

        try {
          const posts = await fetchCircleSpacePosts(slug, token)
          json(200, { posts })
        } catch (err) {
          console.error('[circle] space posts fetch failed:', err)
          json(502, { error: 'circle_unavailable' })
        }
      },
    },
    {
      // Circle redirects unauthenticated users to <your_sso_url>?return_to=<dest>.
      // The frontend /circle-sso page calls this endpoint with the Auth0
      // Bearer token; we verify it, sign a Circle JWT (HS256), and return
      // the redirect URL.
      path: '/api/circle-sso',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

        const circleSecret = env.CIRCLE_SSO_SECRET
        if (!circleSecret) return json(500, { error: 'CIRCLE_SSO_SECRET not configured' })

        let email: string | null = null
        let name: string | undefined
        let tier: 'ark-plus-member' | 'free' = 'free'
        let tierFromClaim = false
        // Checkout-session tokens are minted server-side immediately after a
        // confirmed Stripe payment, so they already vouch for the email's
        // legitimacy. Auth0 access tokens, by contrast, can be issued for
        // unverified addresses (social logins, freshly-created accounts), so
        // we require an explicit email_verified signal before letting the
        // bearer SSO into Circle as that identity.
        let emailVouchedFor = false
        const authHeader = req.headers.authorization
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7)
          const profile = await verifyAuth0BearerProfile(token)
          if (profile) {
            email = profile.email
            name = profile.name
            if (profile.tier) {
              tier = profile.tier
              tierFromClaim = true
            }
            if (profile.emailVerified === true) emailVouchedFor = true
          } else {
            // Not an Auth0 token — could still be a checkout-session token
            // mistakenly passed as Bearer (older clients).
            email = await verifyCheckoutToken(token, env)
            if (email) {
              tier = 'ark-plus-member'
              tierFromClaim = true
              emailVouchedFor = true
            }
          }
        }
        if (!email) {
          const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
          if (cookieToken) {
            email = await verifyCheckoutToken(cookieToken, env)
            if (email) {
              tier = 'ark-plus-member'
              tierFromClaim = true
              emailVouchedFor = true
            }
          }
        }
        if (!email) return json(401, { error: 'unauthenticated' })

        // Email verification gate. The Auth0 access token may not carry an
        // email_verified claim (the Action must be configured to add it), so
        // fall back to a Management API lookup. Fail closed: any ambiguity
        // (null lookup) blocks SSO rather than letting an unverified bearer
        // through.
        if (!emailVouchedFor) {
          const verified = await fetchAuth0EmailVerified(env, email)
          if (verified !== true) {
            return json(403, { error: 'email_not_verified' })
          }
        }

        // Tier fallback: token didn't carry the tier claim (Auth0 Action not
        // yet deployed, or the access token predates it). Look up
        // app_metadata directly. Soft-fail — if the lookup errors, keep the
        // 'free' default rather than blocking SSO.
        if (!tierFromClaim) {
          const looked = await fetchAuth0TierForEmail(env, email)
          if (looked) tier = looked
        }

        const body = (await readJson<{ return_to?: unknown }>(req)) ?? {}
        const returnTo = typeof body.return_to === 'string' ? body.return_to : '/'

        const secret = new TextEncoder().encode(circleSecret)
        const circleJwt = await new SignJWT({
          email,
          name: name ?? email.split('@')[0],
          user_token: email,
          tier,
        })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuedAt()
          .setExpirationTime('10m')
          .sign(secret)

        json(200, {
          jwt: circleJwt,
          redirect_url: `https://app.arkmedia.org/sso?jwt=${encodeURIComponent(circleJwt)}&return_to=${encodeURIComponent(returnTo)}`,
        })
      },
    },
  ]
}
