// Circle integration routes.
//
//   GET  /api/circle/broadcasts — pulls "sent" broadcasts from Circle Admin
//     v2 and projects them to NewsletterPosts. Each newsletter slug maps to
//     a tag editors apply on send.
//   POST /api/circle-sso        — mints a signed JWT so an authenticated
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
import type {
  NewsletterPost,
  NewsletterSlug,
} from '../../src/data/newsletters.js'
import { fetchAuth0EmailVerified, fetchAuth0TierForEmail } from '../entitlement.js'
import { CHECKOUT_COOKIE_NAME, readCookie } from '../lib/cookies.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import {
  verifyAuth0BearerProfile,
  verifyCheckoutToken,
} from '../lib/session.js'
import type { Deps, Route } from '../lib/route.js'
import { isNewsletterSlug } from './newsletter-slugs.js'

const CIRCLE_BROADCASTS_CACHE_TTL_MS = 5 * 60 * 1000
const circleBroadcastsCache = new Map<
  NewsletterSlug,
  { at: number; posts: NewsletterPost[] }
>()

// newsletter slug → { tag editors apply on send, author for the byline }
const CIRCLE_NEWSLETTER_BINDINGS: Partial<
  Record<NewsletterSlug, { tag: string; authorName: string }>
> = {
  'the-call-me-back-newsletter': {
    tag: 'call-me-back',
    authorName: 'Dan Senor',
  },
}

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
  if (cached && Date.now() - cached.at < CIRCLE_BROADCASTS_CACHE_TTL_MS) {
    return cached.posts
  }
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
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))

  circleBroadcastsCache.set(newsletterSlug, { at: Date.now(), posts })
  return posts
}

// ---------------------------------------------------------------------------
// Circle space posts → NewsletterPost
//
// Admin v2 has no `slug` filter on /spaces, so we paginate /spaces, match the
// slug client-side, then fetch /posts?space_id=<id>. Both lookups are cached
// behind the same TTL as broadcasts.
// ---------------------------------------------------------------------------

const CIRCLE_SPACE_POSTS_CACHE_TTL_MS = 5 * 60 * 1000
const circleSpacePostsCache = new Map<
  NewsletterSlug,
  { at: number; posts: NewsletterPost[] }
>()
const circleSpaceIdCache = new Map<string, { at: number; id: number }>()

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
  if (cached && Date.now() - cached.at < CIRCLE_SPACE_POSTS_CACHE_TTL_MS) {
    return cached.id
  }
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
      circleSpaceIdCache.set(spaceSlug, { at: Date.now(), id: match.id })
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
  if (cached && Date.now() - cached.at < CIRCLE_SPACE_POSTS_CACHE_TTL_MS) {
    return cached.posts
  }
  const binding = CIRCLE_SPACE_BINDINGS[newsletterSlug]
  if (!binding) return []

  const spaceId = await resolveSpaceIdBySlug(binding.spaceSlug, token)
  if (spaceId === null) return []

  const matches: CirclePost[] = []
  for (let page = 1; page <= CIRCLE_SPACE_POSTS_MAX_PAGES; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/posts` +
      `?space_id=${encodeURIComponent(String(spaceId))}` +
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
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))

  circleSpacePostsCache.set(newsletterSlug, { at: Date.now(), posts })
  return posts
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
        let tier: 'subscriber' | 'free' = 'free'
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
              tier = 'subscriber'
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
              tier = 'subscriber'
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
