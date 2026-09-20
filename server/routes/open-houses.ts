// Open House routes.
//
//   GET /api/open-houses — public. The upcoming sessions for the /fold page,
//     soonest first. Read by every logged-out visitor, so a DB hiccup degrades
//     to an empty list (the section hides) rather than an error.
//   /api/admin/open-houses — admin-only GET/PUT of the whole config, including
//     sessions that have already happened. Gated by the Auth0 "admin" role.
//
// The public route filters to upcoming and the admin route does not, on
// purpose: the back office needs to see the past rows to copy a link off one
// or clean it up, and the public page must never list a session that's over.

import { readJson, setReadCacheControl } from '../lib/http.js'
import { requireAdminRequest } from '../lib/guards.js'
import { logAdminAction } from '../lib/admin-audit.js'
import { getDb } from '../lib/db.js'
import { getOpenHouseConfig, setOpenHouseConfig } from '../lib/app-settings.js'
import {
  DEFAULT_OPEN_HOUSE_CONFIG,
  upcomingOpenHouses,
  validateOpenHouseConfig,
  type OpenHouseConfig,
} from '../../shared/open-house.js'
import { makeTTLCache } from '../../shared/ttl-cache.js'
import { defineRoute } from '../lib/route.js'
import type { Deps, Route } from '../lib/route.js'

// The config is cached, not the filtered list: which sessions are "upcoming"
// depends on the instant of the request, so filtering has to happen per call or
// a session would linger for a minute after it ended. Admin writes clear it.
const CONFIG_TTL_MS = 60_000
const CONFIG_KEY = 'config'
const configCache = makeTTLCache<string, OpenHouseConfig>(CONFIG_TTL_MS)

// Test-only: drop the cache between cases so each starts cold. Production code
// never calls this — the cache expires on its own TTL and admin writes clear it.
// Mirrors __resetCircleCachesForTests in routes/circle.ts.
export function __resetOpenHouseCacheForTests(): void {
  configCache.clear()
}

export function openHouseRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/open-houses',
      method: 'GET',
      handler: async (_req, res, json) => {
        // Short edge cache. Deliberately shorter than most public reads — a
        // listing whose whole job is "this is happening soon" should not be
        // served stale across the moment a session drops off it.
        setReadCacheControl(res, { gated: false, maxAgeSec: 60 })

        if (!env.DATABASE_URL) {
          return json(200, {
            sessions: upcomingOpenHouses(DEFAULT_OPEN_HOUSE_CONFIG, Date.now()),
          })
        }

        try {
          let config = configCache.get(CONFIG_KEY)
          if (!config) {
            config = await getOpenHouseConfig(getDb(env))
            configCache.set(CONFIG_KEY, config)
          }
          json(200, { sessions: upcomingOpenHouses(config, Date.now()) })
        } catch (err) {
          // One marketing section, not the page. Empty hides it.
          console.error('[open-houses] lookup failed:', err)
          json(200, { sessions: [] })
        }
      },
    }),
    defineRoute({
      path: '/api/admin/open-houses',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        // Back-office data: never stored by a browser or a shared cache.
        setReadCacheControl(res, { gated: true })
        if (!env.DATABASE_URL) {
          return json(500, { error: 'database_not_configured' })
        }
        const sql = getDb(env)

        if (req.method === 'GET') {
          return json(200, { config: await getOpenHouseConfig(sql) })
        }
        if (req.method === 'PUT') {
          const v = validateOpenHouseConfig(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          await setOpenHouseConfig(sql, v.value)
          configCache.clear()
          await logAdminAction(env, admin, req, {
            action: 'open_houses.update',
            summary: `sessions=${v.value.sessions.length}`,
          })
          return json(200, { config: v.value })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    }),
  ]
}
