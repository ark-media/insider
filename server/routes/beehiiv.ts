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
import { makeJsonRes } from '../lib/http.js'
import type { Deps, Env, Route } from '../lib/route.js'
import { isNewsletterSlug } from './newsletter-slugs.js'

const BEEHIIV_POSTS_CACHE_TTL_MS = 5 * 60 * 1000
const beehiivPostsCache = new Map<
  NewsletterSlug,
  { at: number; posts: NewsletterPost[] }
>()

// newsletter slug → author fallback for posts whose Beehiiv `authors[]` is
// empty. Beehiiv usually populates authors, so this is just safety-net copy.
const BEEHIIV_AUTHOR_FALLBACK: Partial<Record<NewsletterSlug, string>> = {
  'ark-daily': 'Ark Media newsroom',
  'for-heavens-sake-newsletter': 'Donniel Hartman & Yossi Klein Halevi',
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
  if (cached && Date.now() - cached.at < BEEHIIV_POSTS_CACHE_TTL_MS) {
    return cached.posts
  }
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
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))

  beehiivPostsCache.set(newsletterSlug, { at: Date.now(), posts })
  return posts
}

export function beehiivRoutes({ env }: Deps): Route[] {
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
          json(200, { posts })
        } catch (err) {
          console.error('[beehiiv] posts fetch failed:', err)
          json(502, { error: 'beehiiv_unavailable' })
        }
      },
    },
  ]
}
