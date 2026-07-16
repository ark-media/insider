// Admin-triggered backfill of feed activations from Supporting Cast download
// history. For members who set up their feeds before the feed.activated webhook
// existed (notably bulk-migrated Insider subscribers), a download is proof the
// feed is set up — so we seed sc_feed_activations from /v1/downloads.
//
//   POST /api/admin/backfill-feed-activations
//     body (optional): { "sinceDays": 365 }  — only scan downloads newer than
//     this many days (bounds the SC paging). Omit to scan all history.
//
// Safe to re-run: the write is create-if-absent, so real webhook-recorded
// activations/revocations always win. Admin-gated + same-origin.

import { makeJsonRes, readJson } from '../lib/http.js'
import { requireAdminRequest } from '../lib/guards.js'
import { getDb } from '../lib/db.js'
import { runFeedActivationBackfill } from '../lib/feed-activation-backfill.js'
import { createScV1Client } from '../lib/sc-client.js'
import type { Deps, Route } from '../lib/route.js'

export function adminFeedActivationRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    {
      path: '/api/admin/backfill-feed-activations',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!env.DATABASE_URL) {
          return json(500, { error: 'database_not_configured' })
        }

        const body = (await readJson<{ sinceDays?: unknown }>(req)) ?? {}
        let fromIso: string | undefined
        if (body.sinceDays !== undefined) {
          const days = Number(body.sinceDays)
          if (!Number.isFinite(days) || days <= 0) {
            return json(400, { error: 'sinceDays must be a positive number' })
          }
          fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
        }

        try {
          const summary = await runFeedActivationBackfill({
            sql: getDb(env),
            sc: createScV1Client(env),
            fromIso,
          })
          json(200, summary)
        } catch (err) {
          console.error('[admin] feed-activation backfill failed:', err)
          json(502, { error: 'backfill_failed' })
        }
      },
    },
  ]
}
