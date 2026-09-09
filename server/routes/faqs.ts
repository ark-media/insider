// FAQ routes.
//
//   GET /api/faqs — public. Enabled FAQs only, in display order. Read on the
//     public site, so failures degrade to an empty list rather than breaking
//     render.
//   /api/admin/faqs — admin-only CRUD (GET list, POST create, PUT ?id,
//     DELETE ?id). Gated by the Auth0 "admin" role.

import { readJson } from '../lib/http.js'
import { requireAdminRequest } from '../lib/guards.js'
import { getDb } from '../lib/db.js'
import {
  createFaq,
  deleteFaq,
  DuplicateFaqKeyError,
  listEnabledFaqs,
  listFaqs,
  updateFaq,
  validateFaqInput,
} from '../lib/faqs.js'
import { defineRoute } from '../lib/route.js'
import type { Deps, Route } from '../lib/route.js'

export function faqRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/faqs',
      method: 'GET',
      handler: async (_req, res, json) => {
        // FAQs change rarely; a short edge cache with SWR keeps the section
        // snappy without going stale for long.
        res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300')

        if (!env.DATABASE_URL) return json(200, { faqs: [] })
        try {
          const sql = getDb(env)
          return json(200, { faqs: await listEnabledFaqs(sql) })
        } catch (err) {
          // A DB hiccup shouldn't break the page — show nothing.
          console.error('[faqs] public lookup failed:', err)
          return json(200, { faqs: [] })
        }
      },
    }),
    defineRoute({
      path: '/api/admin/faqs',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return

        const sql = getDb(env)
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')

        if (req.method === 'GET') {
          return json(200, { faqs: await listFaqs(sql) })
        }
        // A key collision is the one write failure an editor can fix from the
        // form, so it gets its own message naming the key rather than the
        // catch-all's `internal_error`.
        const keyTaken = (key: string) =>
          json(409, {
            error: `The key "${key}" is already used by another FAQ. Pick a different one.`,
          })

        if (req.method === 'POST') {
          const v = validateFaqInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          try {
            const faq = await createFaq(sql, v.value)
            return json(200, { faq })
          } catch (err) {
            if (err instanceof DuplicateFaqKeyError) return keyTaken(err.key)
            throw err
          }
        }
        // PUT (full replace) — the editor always submits the whole record.
        if (req.method === 'PUT') {
          if (!id) return json(400, { error: 'id required' })
          const v = validateFaqInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          try {
            const updated = await updateFaq(sql, id, v.value)
            if (!updated) return json(404, { error: 'not_found' })
            return json(200, { faq: updated })
          } catch (err) {
            if (err instanceof DuplicateFaqKeyError) return keyTaken(err.key)
            throw err
          }
        }
        if (req.method === 'DELETE') {
          if (!id) return json(400, { error: 'id required' })
          const ok = await deleteFaq(sql, id)
          if (!ok) return json(404, { error: 'not_found' })
          return json(200, { ok: true })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    }),
  ]
}
