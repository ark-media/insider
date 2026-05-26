// Discuss-thread admin routes.
//
//   GET    /api/admin/discuss-threads — list every mapping row.
//   POST   /api/admin/discuss-threads — create Circle thread + patch Beehiiv
//                                       draft + persist row. Idempotent on
//                                       beehiiv_post_id.
//   DELETE /api/admin/discuss-threads?id=… — drop the mapping row only. The
//                                       Circle thread and Beehiiv post are
//                                       left alone (admin should clean those
//                                       up by hand if intended).
//   GET    /api/admin/beehiiv-drafts?newsletter=… — list draft posts for the
//                                       chosen newsletter so the admin can
//                                       pick one to attach a thread to.

import { circleUrls } from '../../src/config/urls.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import { requireAdmin } from '../lib/session.js'
import { getDb } from '../lib/db.js'
import {
  createCompanionThread,
  deleteDiscussThread,
  listBeehiivDrafts,
  listDiscussThreads,
  validateCreateThreadInput,
} from '../lib/discuss-threads.js'
import type { Deps, Env, Route } from '../lib/route.js'
import { isNewsletterSlug } from './newsletter-slugs.js'
import type { NewsletterSlug } from '../../src/data/newsletters.js'

function resolveBeehiivPublicationId(
  env: Env,
  newsletterSlug: NewsletterSlug,
): string | undefined {
  const key = `BEEHIIV_PUBLICATION_ID_${newsletterSlug.toUpperCase().replace(/-/g, '_')}`
  const value = env[key]
  return value && value.trim() ? value.trim() : undefined
}

// UUID v1-v5 shape. discuss_threads.id is gen_random_uuid() (v4), so this
// is just enough validation to reject obvious garbage before it reaches the
// DB. The DELETE query already parameterizes the value, so this is for
// hygiene / error clarity rather than SQL safety.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function discussThreadsRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    {
      path: '/api/admin/discuss-threads',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdmin(req)
        if (!admin) return json(403, { error: 'forbidden' })
        if (!env.DATABASE_URL) return json(500, { error: 'DATABASE_URL not configured' })

        const sql = getDb(env)
        const url = new URL(req.url ?? '/', 'http://x')

        if (req.method === 'GET') {
          return json(200, { threads: await listDiscussThreads(sql) })
        }

        if (req.method === 'POST') {
          const v = validateCreateThreadInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })

          const circleToken = env.CIRCLE_ADMIN_API_TOKEN
          if (!circleToken) return json(500, { error: 'CIRCLE_ADMIN_API_TOKEN not configured' })
          const beehiivToken = env.BEEHIIV_API_KEY
          if (!beehiivToken) return json(500, { error: 'BEEHIIV_API_KEY not configured' })
          const publicationId = resolveBeehiivPublicationId(env, v.value.newsletterSlug)
          if (!publicationId) {
            return json(500, {
              error: `BEEHIIV_PUBLICATION_ID_${v.value.newsletterSlug.toUpperCase().replace(/-/g, '_')} not configured`,
            })
          }

          const result = await createCompanionThread(sql, v.value, {
            circleToken,
            beehiivToken,
            beehiivPublicationId: publicationId,
            communityHost: circleUrls.community,
            appBaseUrl,
          })
          if (!result.ok) return json(result.status, { error: result.error })
          return json(200, {
            thread: result.thread,
            alreadyExisted: result.alreadyExisted,
          })
        }

        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id')
          if (!id) return json(400, { error: 'id required' })
          if (!UUID_RE.test(id)) return json(400, { error: 'invalid id format' })
          const ok = await deleteDiscussThread(sql, id)
          if (!ok) return json(404, { error: 'not_found' })
          return json(200, { ok: true })
        }

        return json(405, { error: 'Method Not Allowed' })
      },
    },
    {
      path: '/api/admin/beehiiv-drafts',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdmin(req)
        if (!admin) return json(403, { error: 'forbidden' })
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

        const url = new URL(req.url ?? '/', 'http://x')
        const slug = url.searchParams.get('newsletter')
        if (!slug) return json(400, { error: 'missing `newsletter`' })
        if (!isNewsletterSlug(slug)) return json(400, { error: 'invalid `newsletter`' })

        const token = env.BEEHIIV_API_KEY
        if (!token) return json(200, { drafts: [] })
        const publicationId = resolveBeehiivPublicationId(env, slug)
        if (!publicationId) return json(200, { drafts: [] })

        try {
          const drafts = await listBeehiivDrafts({ token, publicationId })
          json(200, { drafts })
        } catch (err) {
          console.error('[admin/beehiiv-drafts] fetch failed:', err)
          json(502, { error: 'beehiiv_unavailable' })
        }
      },
    },
  ]
}
