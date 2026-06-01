// Careers routes.
//
//   GET /api/careers — public. Enabled postings only. With ?slug=<slug>,
//     returns the single matching enabled posting (for the detail page), else a
//     404. Read on the public site, so failures degrade to an empty list
//     rather than breaking render.
//   /api/admin/careers — admin-only CRUD (GET list, POST create, PUT ?id,
//     DELETE ?id). Gated by the Auth0 "admin" role. Duplicate slugs return 409.

import { makeJsonRes, readJson } from '../lib/http.js'
import { requireAdmin } from '../lib/session.js'
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
import type { Deps, Route } from '../lib/route.js'

export function careerRoutes({ env }: Deps): Route[] {
  return [
    {
      path: '/api/careers',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })
        // Job postings change rarely; a short edge cache with SWR keeps the
        // list snappy without going stale for long.
        res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300')

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
    },
    {
      path: '/api/admin/careers',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdmin(req)
        if (!admin) return json(403, { error: 'forbidden' })

        const sql = getDb(env)
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')

        if (req.method === 'GET') {
          return json(200, { careers: await listCareers(sql) })
        }
        if (req.method === 'POST') {
          const v = validateCareerInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          try {
            const career = await createCareer(sql, v.value)
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
          return json(200, { ok: true })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    },
  ]
}
