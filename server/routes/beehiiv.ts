// Beehiiv API v2 — Posts
//
// Pulls confirmed (published) posts from a Beehiiv publication and projects
// them to NewsletterPosts. Used by public newsletter pages whose source is
// `beehiivSource`. The API key is a server-side secret (BEEHIIV_API_KEY).
// Each newsletter slug maps to a publication id resolved from env via
// BEEHIIV_PUBLICATION_ID_<SLUG_UPPER>.

import {
  isPublishedBeehiivPost,
  projectBeehiivPost,
  type BeehiivPost,
} from '../beehiiv-posts.js'
import type {
  NewsletterPost,
  NewsletterSlug,
} from '../../src/data/newsletters.js'
import type { IncomingMessage } from 'node:http'
import { getDb } from '../lib/db.js'
import { listDiscussThreadsByNewsletter } from '../lib/discuss-threads.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import type { Deps, Env, Route } from '../lib/route.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import { isNewsletterSlug } from './newsletter-slugs.js'

const BEEHIIV_POSTS_CACHE_TTL_MS = 5 * 60 * 1000
const beehiivPostsCache = makeTTLCache<NewsletterSlug, NewsletterPost[]>(
  BEEHIIV_POSTS_CACHE_TTL_MS,
)

// newsletter slug → author fallback for posts whose Beehiiv `authors[]` is
// empty. Beehiiv usually populates authors, so this is just safety-net copy.
const BEEHIIV_AUTHOR_FALLBACK: Partial<Record<NewsletterSlug, string>> = {
  'ark-daily': 'Ark Media newsroom',
  'members-letter': 'Ark Media editorial',
}

function resolveBeehiivPublicationId(
  env: Env,
  newsletterSlug: NewsletterSlug,
): string | undefined {
  // Same shape as resolveSimplecastPodcastId: derive an env key from the
  // newsletter slug. The slug is from a closed union (NewsletterSlug), so
  // the derived key can't be attacker-controlled.
  const key = `BEEHIIV_PUBLICATION_ID_${newsletterSlug.toUpperCase().replace(/-/g, '_')}`
  const value = env[key]
  return value && value.trim() ? value.trim() : undefined
}

async function fetchBeehiivPosts(
  newsletterSlug: NewsletterSlug,
  token: string,
  env: Env,
): Promise<NewsletterPost[]> {
  const cached = beehiivPostsCache.get(newsletterSlug)
  if (cached) return cached
  const publicationId = resolveBeehiivPublicationId(env, newsletterSlug)
  if (!publicationId) return []
  // Beehiiv publication ids carry a stable `pub_` prefix. Validate before
  // interpolating into the upstream URL.
  if (!/^pub_[A-Za-z0-9-]+$/.test(publicationId)) return []

  // v2 returns paginated results; 50 is plenty for the "Recent issues" list.
  // `expand[]=free_web_content` is required to get the HTML body — by
  // default v2 returns only metadata. We never request premium_web_content,
  // so gated content stays on Beehiiv's side of the wire.
  const url =
    `https://api.beehiiv.com/v2/publications/${publicationId}/posts` +
    `?status=confirmed&limit=50&expand[]=free_web_content`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Beehiiv ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { data?: BeehiivPost[] }
  const authorFallback = BEEHIIV_AUTHOR_FALLBACK[newsletterSlug] ?? ''

  const posts: NewsletterPost[] = (body.data ?? [])
    .filter(isPublishedBeehiivPost)
    .map((p) => projectBeehiivPost(p, newsletterSlug, authorFallback))
    .filter((p): p is NewsletterPost => p !== null)
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        a.slug.localeCompare(b.slug),
    )

  beehiivPostsCache.set(newsletterSlug, posts)
  return posts
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

// Extracts the leftmost IP from x-forwarded-for (Vercel sets this) and falls
// back to the socket address for the dev server. The leftmost entry is the
// original client; downstream proxies append themselves to the right.
function getClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim()
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0]!
  }
  return req.socket?.remoteAddress ?? 'unknown'
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

        // Same SWR pattern as the Circle broadcasts route — the edge cache
        // absorbs traffic between cold starts via stale-while-revalidate.
        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=3600',
        )

        const token = env.BEEHIIV_API_KEY
        if (!token) return json(200, { posts: [] })

        try {
          const posts = await fetchBeehiivPosts(slug, token, env)
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
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
  ]
}
