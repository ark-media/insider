// Beehiiv API v2 — Posts
//
// Pulls confirmed (published) posts from a Beehiiv publication and projects
// them to NewsletterPosts. Used by public newsletter pages whose source is
// `beehiivSource`. The API key is a server-side secret (BEEHIIV_API_KEY).
// Each newsletter slug maps to a publication id resolved from env via
// BEEHIIV_PUBLICATION_ID_<SLUG_UPPER>.

import { secretEquals } from '../lib/timing-safe.js'
import { isValidEmail } from '../../shared/validation.js'
import {
  isPublishedBeehiivPost,
  projectBeehiivPost,
  type BeehiivPost,
} from '../beehiiv-posts.js'
import type {
  NewsletterPost,
  NewsletterSlug,
} from '../../src/data/newsletters.js'
import {
  deleteLocalSubscription,
  getLocalSubscription,
  persistFromBeehiiv,
  type BeehiivSubscription,
} from '../lib/beehiiv-sync.js'
import { getDb, type Sql } from '../lib/db.js'
import { fetchAuth0EmailVerified } from '../entitlement.js'
import { resolveMembership } from '../lib/entitlement-resolver.js'
import { listDiscussThreadsByNewsletter } from '../lib/discuss-threads.js'
import { getClientIp, makeJsonRes, readBody, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import type { Deps, Env, Route } from '../lib/route.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import { isNewsletterSlug, resolveBeehiivPublicationId } from './newsletter-slugs.js'

// Cache the raw upstream Beehiiv response keyed by publication id. Two slugs
// can map to the same publication (e.g. ark-daily and members-letter sharing
// one publication with audience-tiered posts), so caching at the publication
// level — not the slug level — lets both surfaces share one upstream fetch.
// Projection (audience filtering, free vs. premium body) then runs per
// request against this raw data, since it varies with the reader's tier.
const BEEHIIV_RAW_CACHE_TTL_MS = 5 * 60 * 1000
const beehiivRawCache = makeTTLCache<string, BeehiivPost[]>(
  BEEHIIV_RAW_CACHE_TTL_MS,
)

// newsletter slug → author fallback for posts whose Beehiiv `authors[]` is
// empty. Beehiiv usually populates authors, so this is just safety-net copy.
const BEEHIIV_AUTHOR_FALLBACK: Partial<Record<NewsletterSlug, string>> = {
  'ark-daily': 'Ark Media newsroom',
  'members-letter': 'Ark Media editorial',
}

async function fetchBeehiivRaw(
  publicationId: string,
  token: string,
): Promise<BeehiivPost[]> {
  const cached = beehiivRawCache.get(publicationId)
  if (cached) return cached
  // Beehiiv publication ids carry a stable `pub_` prefix. Validate before
  // interpolating into the upstream URL.
  if (!/^pub_[A-Za-z0-9-]+$/.test(publicationId)) return []

  // v2 returns paginated results; 50 is plenty for the "Recent issues" list.
  // Both `expand[]` variants are requested so the same cache entry serves
  // members (premium body) and non-members (above-divider preview). The
  // route handler decides which body to project per request — premium HTML
  // never leaves the server for an unauthenticated reader.
  const url =
    `https://api.beehiiv.com/v2/publications/${publicationId}/posts` +
    `?status=confirmed&limit=50` +
    `&expand[]=free_web_content&expand[]=premium_web_content`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Beehiiv ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { data?: BeehiivPost[] }
  const posts = body.data ?? []
  beehiivRawCache.set(publicationId, posts)
  return posts
}

// Each newsletter slug owns a slice of the publication's posts based on the
// post's `audience`. A single publication can host both surfaces — ark-daily
// (free + both) and members-letter (premium + both). `both` posts appear on
// both surfaces, rendered differently per surface (preview-only on ark-daily,
// full-for-members + paywall-for-others on members-letter).
function postBelongsToNewsletter(
  p: BeehiivPost,
  newsletterSlug: NewsletterSlug,
): boolean {
  const audience = (p.audience ?? 'free').toLowerCase()
  if (newsletterSlug === 'members-letter') {
    return audience === 'premium' || audience === 'both'
  }
  return audience !== 'premium'
}

async function buildBeehiivPosts(
  newsletterSlug: NewsletterSlug,
  token: string,
  env: Env,
  isMember: boolean,
): Promise<NewsletterPost[]> {
  const publicationId = resolveBeehiivPublicationId(env, newsletterSlug)
  if (!publicationId) return []
  const raw = await fetchBeehiivRaw(publicationId, token)
  const authorFallback = BEEHIIV_AUTHOR_FALLBACK[newsletterSlug] ?? ''
  const view: 'free' | 'premium' = isMember ? 'premium' : 'free'

  return raw
    .filter(isPublishedBeehiivPost)
    .filter((p) => postBelongsToNewsletter(p, newsletterSlug))
    .map((p) => projectBeehiivPost(p, newsletterSlug, authorFallback, view))
    .filter((p): p is NewsletterPost => p !== null)
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        a.slug.localeCompare(b.slug),
    )
}

// Best-effort enrichment: attach `discussUrl` to each post whose Beehiiv id
// has a matching mapping row. Runs after the cache so a mapping created in
// /admin shows up on the next request even while the upstream Beehiiv list
// is still cached. Soft-fails — a DB hiccup hides the buttons, not the posts.
async function enrichWithDiscussUrls(
  posts: NewsletterPost[],
  newsletterSlug: NewsletterSlug,
  env: Env,
): Promise<NewsletterPost[]> {
  if (!env.DATABASE_URL) return posts
  try {
    const sql = getDb(env)
    const threads = await listDiscussThreadsByNewsletter(sql, newsletterSlug)
    if (threads.length === 0) return posts
    const byPostId = new Map(threads.map((t) => [t.beehiivPostId, t.circleThreadUrl]))
    return posts.map((p) =>
      p.beehiivPostId && byPostId.has(p.beehiivPostId)
        ? { ...p, discussUrl: byPostId.get(p.beehiivPostId) }
        : p,
    )
  } catch (err) {
    console.error('[beehiiv] discuss-thread join failed:', err)
    return posts
  }
}

// Best-effort detection of Beehiiv's "already subscribed" error so we can show
// a friendlier message. With `reactivate_existing: true`, Beehiiv usually
// returns 201 even for existing emails — this is a safety net for cases where
// it doesn't (e.g. status: 'blocked' or 'spam_reported' subscribers).
function isAlreadySubscribedError(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('already') ||
    lower.includes('exists') ||
    lower.includes('duplicate')
  )
}

async function createBeehiivSubscription(
  publicationId: string,
  token: string,
  email: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!/^pub_[A-Za-z0-9-]+$/.test(publicationId)) {
    return { ok: false, status: 500, error: 'invalid_publication_id' }
  }
  const url = `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email,
      // Re-subscribe readers who previously unsubscribed instead of erroring.
      reactivate_existing: true,
      // Tag the source so we can distinguish site signups in Beehiiv.
      utm_source: 'insider-site',
    }),
  })
  if (res.ok) return { ok: true }
  const text = await res.text().catch(() => '')
  console.error(`[beehiiv] subscribe ${res.status}: ${text}`)
  if (res.status >= 400 && res.status < 500) {
    if (isAlreadySubscribedError(text)) {
      return { ok: false, status: 409, error: 'already_subscribed' }
    }
    // Generic client error — don't leak upstream messages.
    return { ok: false, status: 400, error: 'subscribe_rejected' }
  }
  return { ok: false, status: 502, error: 'beehiiv_unavailable' }
}

export function beehiivRoutes({ env }: Deps): Route[] {
  // Per-IP cap on subscribe attempts. 10-token burst then ~12/min steady
  // state — leaves room for typo corrections without letting a script
  // enumerate or spam-subscribe arbitrary addresses.
  const subscribeLimiter = createRateLimiter({
    capacity: 10,
    refillPerSec: 0.2,
  })

  return [
    {
      path: '/api/beehiiv/posts',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

        const url = new URL(req.url ?? '', 'http://x')
        const slug = url.searchParams.get('newsletter')
        if (!slug) return json(400, { error: 'missing `newsletter`' })
        if (!isNewsletterSlug(slug)) {
          return json(400, { error: 'invalid `newsletter`' })
        }

        // The premium newsletter body rides the arkPlus axis; resolve it from
        // Neon (the authority). Anonymous readers resolve to non-member and keep
        // the shared-cacheable above-divider preview.
        const resolved = await resolveMembership(req, env)
        const isMember = resolved?.entitlements.arkPlus ?? false

        // Member responses include the gated body, so they must NOT be
        // cached on a shared edge — `private, no-store` keeps that content
        // tied to the requesting reader. Anonymous responses are safe to
        // share-cache with the existing SWR window.
        if (isMember) {
          res.setHeader('cache-control', 'private, no-store')
        } else {
          res.setHeader(
            'cache-control',
            'public, s-maxage=300, stale-while-revalidate=3600',
          )
        }

        const token = env.BEEHIIV_API_KEY
        if (!token) return json(200, { posts: [] })

        try {
          const posts = await buildBeehiivPosts(slug, token, env, isMember)
          const enriched = await enrichWithDiscussUrls(posts, slug, env)
          json(200, { posts: enriched })
        } catch (err) {
          console.error('[beehiiv] posts fetch failed:', err)
          json(502, { error: 'beehiiv_unavailable' })
        }
      },
    },
    {
      path: '/api/beehiiv/subscribe',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

        const wait = subscribeLimiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        const body = await readJson<{ newsletter?: unknown; email?: unknown }>(req)
        const slug = typeof body?.newsletter === 'string' ? body.newsletter : null
        const email = typeof body?.email === 'string' ? body.email.trim() : ''
        if (!slug || !isNewsletterSlug(slug)) {
          return json(400, { error: 'invalid `newsletter`' })
        }
        if (!isValidEmail(email)) {
          return json(400, { error: 'invalid_email' })
        }

        const token = env.BEEHIIV_API_KEY
        const publicationId = resolveBeehiivPublicationId(env, slug)
        if (!token || !publicationId) {
          console.error('[beehiiv] subscribe missing config', {
            hasToken: !!token,
            hasPublicationId: !!publicationId,
            slug,
          })
          return json(503, { error: 'beehiiv_not_configured' })
        }

        try {
          const result = await createBeehiivSubscription(publicationId, token, email)
          if (result.ok) return json(200, { ok: true })
          return json(result.status, { error: result.error })
        } catch (err) {
          console.error('[beehiiv] subscribe failed:', err)
          json(502, { error: 'beehiiv_unavailable' })
        }
      },
    },
    {
      // Inbound webhook from Beehiiv.
      //
      // Auth: Beehiiv doesn't publish a documented HMAC signature scheme,
      // so we gate the route with a shared secret in the query string
      // (`?key=…`). Register the URL in Beehiiv as
      //   https://<APP_BASE_URL>/api/beehiiv/webhook?key=$BEEHIIV_WEBHOOK_SECRET
      // and subscribe to the subscription.* event types.
      //
      // Caveat — query-string secret leakage. The `?key=` value appears in
      // upstream HTTP access logs (Vercel / CDN / proxy) more than headers
      // would. We accept the trade-off because (a) Beehiiv's webhook
      // configuration doesn't support custom headers, and (b) the impact of
      // a leaked secret is bounded by the second-layer check below: we only
      // persist events for emails our application already knows about
      // (existing mirror row or Auth0 user). A leaked key still lets an
      // attacker replay events, but only for our real readers — not inject
      // ghost subscribers.
      path: '/api/beehiiv/webhook',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

        const secret = env.BEEHIIV_WEBHOOK_SECRET
        if (!secret) return json(500, { error: 'BEEHIIV_WEBHOOK_SECRET missing' })
        const url = new URL(req.url ?? '', 'http://x')
        if (!secretEquals(url.searchParams.get('key') ?? '', secret)) {
          return json(401, { error: 'unauthorized' })
        }

        if (!env.DATABASE_URL) return json(200, { received: true })
        const sql = getDb(env)

        // Beehiiv POSTs raw JSON. Parse it ourselves so the constant-time key
        // check above can run before we touch the body.
        const raw = await readBody(req)
        let event: BeehiivWebhookEvent
        try {
          event = JSON.parse(raw.toString('utf8')) as BeehiivWebhookEvent
        } catch {
          return json(400, { error: 'invalid_json' })
        }

        const publicationId =
          env.BEEHIIV_PUBLICATION_ID_ARK_DAILY ||
          env.BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER ||
          ''
        try {
          await handleBeehiivWebhook(sql, env, event, publicationId)
          json(200, { received: true })
        } catch (err) {
          console.error('[beehiiv] webhook handler failed:', err)
          json(500, { error: 'webhook_handler_failed' })
        }
      },
    },
  ]
}

// --- Webhook event dispatch ----------------------------------------------

type BeehiivWebhookEvent = {
  event_type?: string
  data?: {
    id?: string
    email?: string
    status?: string
    subscription_tier?: 'free' | 'premium'
    subscription_premium_tier_names?: string[]
  }
}

// Soft check: do we know this reader? We accept either an existing mirror
// row OR an Auth0 user. This bounds the blast radius of a leaked webhook
// secret — an attacker can replay events, but only for real readers.
async function isKnownReader(
  sql: Sql,
  env: Env,
  email: string,
): Promise<boolean> {
  const local = await getLocalSubscription(sql, email)
  if (local) return true
  // Not in the mirror yet — accept if Auth0 has a user for this email. This is
  // an existence check (email-verification lookup), not an entitlement read, so
  // it survives the Auth0-entitlement removal (task 5). Returns null on lookup
  // failure or no user; a non-null result means a real Auth0 user exists.
  return (await fetchAuth0EmailVerified(env, email)) !== null
}

async function handleBeehiivWebhook(
  sql: Sql,
  env: Env,
  event: BeehiivWebhookEvent,
  publicationId: string,
): Promise<void> {
  const data = event.data
  if (!data?.email || !data.id) return
  const type = event.event_type ?? ''

  // Reject events for readers we don't recognize. Failing closed here is
  // intentional — see the route comment on secret-leak mitigation.
  if (!(await isKnownReader(sql, env, data.email))) return

  if (type === 'subscription.deleted') {
    await deleteLocalSubscription(sql, data.email)
    return
  }

  // For everything else (created, confirmed, upgraded, downgraded, paused,
  // resumed) Beehiiv has already applied the change — we just mirror the
  // resulting subscription state via the same projection the push paths use.
  if (!publicationId) return
  const sub: BeehiivSubscription = {
    id: data.id,
    email: data.email,
    status: data.status ?? 'active',
    hasPremium:
      data.subscription_tier === 'premium' ||
      (data.subscription_premium_tier_names ?? []).length > 0,
  }
  await persistFromBeehiiv(sql, publicationId, sub)
}
