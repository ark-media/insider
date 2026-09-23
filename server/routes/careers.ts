// Careers routes.
//
//   GET /api/careers — public. Enabled postings only. With ?slug=<slug>,
//     returns the single matching enabled posting (for the detail page), else a
//     404. Read on the public site, so failures degrade to an empty list
//     rather than breaking render.
//   /api/admin/careers — admin-only CRUD (GET list, POST create, PUT ?id,
//     DELETE ?id). Gated by the Auth0 "admin" role. Duplicate slugs return 409.

import { readJson } from '../lib/http.js'
import { requireAdminRequest } from '../lib/guards.js'
import { logAdminAction } from '../lib/admin-audit.js'
import { getDb } from '../lib/db.js'
import {
  createCareer,
  deleteCareer,
  getEnabledCareerBySlug,
  isUniqueViolation,
  listCareers,
  listEnabledCareers,
  updateCareer,
  validateCareerInput,
} from '../lib/careers.js'
import { defineRoute } from '../lib/route.js'
import { isUuid } from './discuss-threads.js'
import type { Deps, Route } from '../lib/route.js'

export function careerRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/careers',
      method: 'GET',
      handler: async (req, res, json) => {
        // Do not edge-cache this. Admin creates, edits, and deletes must show
        // up on the next public read. A shared cache with stale-while-revalidate
        // kept serving deleted roles after the row was already gone.
        res.setHeader('cache-control', 'private, no-store')

        const slug = new URL(req.url ?? '/', 'http://x').searchParams.get('slug')
        // Keep the response shape matching the request even with no DB: a slug
        // lookup answers "not found", a list lookup answers an empty list.
        if (!env.DATABASE_URL) {
          return slug ? json(404, { error: 'not_found' }) : json(200, { careers: [] })
        }
        try {
          const sql = getDb(env)
          if (slug) {
            const career = await getEnabledCareerBySlug(sql, slug)
            if (!career) return json(404, { error: 'not_found' })
            return json(200, { career })
          }
          return json(200, { careers: await listEnabledCareers(sql) })
        } catch (err) {
          // A DB hiccup shouldn't break the careers page — show nothing.
          console.error('[careers] public lookup failed:', err)
          if (slug) return json(404, { error: 'not_found' })
          return json(200, { careers: [] })
        }
      },
    }),
    defineRoute({
      path: '/api/admin/careers',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return

        const sql = getDb(env)
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')
        // A junk `?id=` would reach Postgres as a bad uuid cast and come back as
        // the catch-all's 500. Same check, same answer as discuss-threads.
        if (id !== null && !isUuid(id)) return json(400, { error: 'invalid id format' })

        if (req.method === 'GET') {
          return json(200, { careers: await listCareers(sql) })
        }
        if (req.method === 'POST') {
          const v = validateCareerInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          try {
            const career = await createCareer(sql, v.value)
            await logAdminAction(env, admin, req, {
              action: 'career.create',
              targetId: career.id,
              summary: `slug=${career.slug} enabled=${career.enabled}`,
            })
            return json(200, { career })
          } catch (err) {
            if (isUniqueViolation(err)) {
              return json(409, { error: 'A position with that URL slug already exists.' })
            }
            throw err
          }
        }
        // PUT (full replace) — the editor always submits the whole record.
        if (req.method === 'PUT') {
          if (!id) return json(400, { error: 'id required' })
          const v = validateCareerInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          try {
            const updated = await updateCareer(sql, id, v.value)
            if (!updated) return json(404, { error: 'not_found' })
            await logAdminAction(env, admin, req, {
              action: 'career.update',
              targetId: id,
              summary: `slug=${updated.slug} enabled=${updated.enabled}`,
            })
            return json(200, { career: updated })
          } catch (err) {
            if (isUniqueViolation(err)) {
              return json(409, { error: 'A position with that URL slug already exists.' })
            }
            throw err
          }
        }
        if (req.method === 'DELETE') {
          if (!id) return json(400, { error: 'id required' })
          const ok = await deleteCareer(sql, id)
          if (!ok) return json(404, { error: 'not_found' })
          await logAdminAction(env, admin, req, { action: 'career.delete', targetId: id })
          return json(200, { ok: true })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    }),
  ]
}
