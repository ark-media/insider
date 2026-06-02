// Announcement banner routes.
//
//   GET /api/announcements/active — public. The single banner to show right
//     now (enabled + within its date window), or null. Read on every page
//     load, so failures degrade to "no banner" rather than breaking render.
//   /api/admin/announcements — admin-only CRUD (GET list, POST create,
//     PATCH ?id, DELETE ?id). Gated by the Auth0 "admin" role.

import { makeJsonRes, readJson } from '../lib/http.js'
import { requireAdminRequest } from '../lib/guards.js'
import { getDb } from '../lib/db.js'
import {
  createAnnouncement,
  deleteAnnouncement,
  getActiveAnnouncement,
  listAnnouncements,
  updateAnnouncement,
  validateAnnouncementInput,
  type Announcement,
} from '../lib/announcements.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import type { Deps, Route } from '../lib/route.js'

// The public banner is fetched on every page load by every visitor. This
// per-instance cache dedupes the DB query on a warm function; admin mutations
// clear it so the back office stays responsive. Worst-case staleness for the
// active window is one TTL. A single key is enough — there's only one "active".
const ACTIVE_TTL_MS = 60_000
const ACTIVE_KEY = 'active'
const activeCache = makeTTLCache<string, { announcement: Announcement | null }>(ACTIVE_TTL_MS)

export function announcementRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    {
      path: '/api/announcements/active',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })
        // Short edge cache on top of the in-memory one; SWR keeps it snappy.
        res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60')
        if (!env.DATABASE_URL) return json(200, { announcement: null })

        const cached = activeCache.get(ACTIVE_KEY)
        if (cached) return json(200, cached)

        try {
          const payload = { announcement: await getActiveAnnouncement(getDb(env)) }
          activeCache.set(ACTIVE_KEY, payload)
          json(200, payload)
        } catch (err) {
          // Never let a DB hiccup blank the whole site — just hide the banner.
          console.error('[announcements] active lookup failed:', err)
          json(200, { announcement: null })
        }
      },
    },
    {
      path: '/api/admin/announcements',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return

        const sql = getDb(env)
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')

        if (req.method === 'GET') {
          return json(200, { announcements: await listAnnouncements(sql) })
        }
        if (req.method === 'POST') {
          const v = validateAnnouncementInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          const announcement = await createAnnouncement(sql, v.value)
          activeCache.clear()
          return json(200, { announcement })
        }
        // PUT (full replace) — the editor always submits the whole record.
        if (req.method === 'PUT') {
          if (!id) return json(400, { error: 'id required' })
          const v = validateAnnouncementInput(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          const updated = await updateAnnouncement(sql, id, v.value)
          if (!updated) return json(404, { error: 'not_found' })
          activeCache.clear()
          return json(200, { announcement: updated })
        }
        if (req.method === 'DELETE') {
          if (!id) return json(400, { error: 'id required' })
          const ok = await deleteAnnouncement(sql, id)
          if (!ok) return json(404, { error: 'not_found' })
          activeCache.clear()
          return json(200, { ok: true })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    },
  ]
}
