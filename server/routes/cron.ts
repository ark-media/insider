// Entitlement reconciliation cron. Vercel cron hits this nightly. Three-pass
// sync against Stripe + Auth0 + Circle; see ../entitlement.ts for the
// passes.
//
// Auth: cron requests from Vercel include `Authorization: Bearer
// <CRON_SECRET>` matching the secret set in the project's environment.

import { secretEquals } from '../lib/timing-safe.js'
import { reconcileEntitlements } from '../entitlement.js'
import { getDb } from '../lib/db.js'
import { getReminderConfig } from '../lib/app-settings.js'
import { runFeedSetupReminders } from '../lib/feed-reminders.js'
import { createScV1Client } from '../lib/sc-client.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import type { IncomingMessage } from 'node:http'

// Cron requests from Vercel carry `Authorization: Bearer <CRON_SECRET>`.
// Constant-time compare so a wrong secret can't be guessed byte-by-byte via
// response-timing differences. Returns false when the secret is unset (the
// caller maps that to a 500 separately).
function cronAuthorized(req: IncomingMessage, cronSecret: string): boolean {
  return secretEquals(req.headers.authorization ?? '', `Bearer ${cronSecret}`)
}

export function cronRoutes({ env, stripe, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/cron/reconcile-entitlements',
      method: ['POST', 'GET'],
      handler: async (req, res, json) => {
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'CRON_SECRET missing' })
        if (!cronAuthorized(req, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const summary = await reconcileEntitlements(env, stripe)
        json(200, {
          scanned: summary.scanned,
          scRemoved: summary.scRemoved,
          circleRemoved: summary.circleRemoved,
          errors: summary.errors,
        })
      },
    }),
    defineRoute({
      // Nudge members who joined but haven't finished setting up their private
      // feeds. Scans the SC roster, sends a one-time Resend reminder to the
      // incomplete ones, and records each send so nobody is nagged twice.
      path: '/api/cron/feed-setup-reminders',
      method: ['POST', 'GET'],
      handler: async (req, res, json) => {
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'CRON_SECRET missing' })
        if (!cronAuthorized(req, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!env.DATABASE_URL) {
          return json(500, { error: 'DATABASE_URL missing' })
        }

        const sql = getDb(env)
        try {
          const config = await getReminderConfig(sql, env)
          const summary = await runFeedSetupReminders({
            env,
            sql,
            sc: createScV1Client(env),
            appBaseUrl,
            config,
            nowMs: Date.now(),
          })
          json(200, summary)
        } catch (err) {
          console.error('[cron] feed-setup-reminders failed:', err)
          json(500, { error: 'reminder_run_failed' })
        }
      },
    }),
  ]
}
