// Launch-mode routes.
//
//   GET /api/launch-mode — public. The current site launch mode ("soft" |
//     "hard"), read on every page load to decide whether the focused
//     soft-launch experience or the full site renders. Failures degrade to
//     "soft" (the safe, nothing-leaks default) rather than breaking render.
//   /api/admin/launch-mode — admin-only. GET current, PUT to change. Gated by
//     the Auth0 "admin" role.

import { makeJsonRes, readJson } from '../lib/http.js'
import { requireAdminRequest } from '../lib/guards.js'
import { getDb } from '../lib/db.js'
import {
  DEFAULT_LAUNCH_MODE,
  getLaunchMode,
  isLaunchMode,
  setLaunchMode,
  type LaunchMode,
} from '../lib/settings.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import type { Deps, Route } from '../lib/route.js'

// Like the announcement banner, the launch mode is read on every page load by
// every visitor, so dedupe the DB query on a warm function. There's only one
// global value, so a single key suffices; the admin write clears it.
const MODE_TTL_MS = 60_000
const MODE_KEY = 'mode'
const modeCache = makeTTLCache<string, { mode: LaunchMode }>(MODE_TTL_MS)

export function launchRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    {
      path: '/api/launch-mode',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })
        // Short edge cache on top of the in-memory one; SWR keeps it snappy.
        res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60')
        if (!env.DATABASE_URL) return json(200, { mode: DEFAULT_LAUNCH_MODE })

        const cached = modeCache.get(MODE_KEY)
        if (cached) return json(200, cached)

        try {
          const payload = { mode: await getLaunchMode(getDb(env)) }
          modeCache.set(MODE_KEY, payload)
          json(200, payload)
        } catch (err) {
          // Never let a DB hiccup break render — fall back to the safe default.
          console.error('[launch] mode lookup failed:', err)
          json(200, { mode: DEFAULT_LAUNCH_MODE })
        }
      },
    },
    {
      path: '/api/admin/launch-mode',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return

        const sql = getDb(env)
        if (req.method === 'GET') {
          return json(200, { mode: await getLaunchMode(sql) })
        }
        if (req.method === 'PUT') {
          const body = (await readJson(req)) as { mode?: unknown } | null
          if (!isLaunchMode(body?.mode)) {
            return json(400, { error: 'mode must be "soft" or "hard".' })
          }
          const mode = await setLaunchMode(sql, body.mode)
          modeCache.clear()
          return json(200, { mode })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    },
  ]
}
