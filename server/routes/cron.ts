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
import {
  GIFT_EXPIRY_REMINDER_DAYS,
  runGiftExpiryReminders,
} from '../lib/gift-expiry-reminders.js'
import { getAuth0NameProfile } from '../lib/auth0-user.js'
import { greetingFirstName } from '../../shared/profile-name.js'
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

// How long a webhook-dedup marker outlives its delivery. The `*_webhook_events`
// tables hold one (id, type, received_at) row per event purely to reject a
// provider's retried delivery; once the retry window has long passed the marker
// is dead weight. 90 days dwarfs any Stripe/SC retry window, so pruning past it
// can never drop a marker that could still match a live retry.
const WEBHOOK_EVENT_RETENTION_DAYS = 90

export function cronRoutes({ env, stripe, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/cron/reconcile-entitlements',
      method: ['POST', 'GET'],
      handler: async (req, _res, json) => {
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'not_configured' })
        if (!cronAuthorized(req, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!stripe) return json(500, { error: 'not_configured' })

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
      handler: async (req, _res, json) => {
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'not_configured' })
        if (!cronAuthorized(req, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!env.DATABASE_URL) {
          return json(500, { error: 'not_configured' })
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
    defineRoute({
      // Nudge gift recipients whose gifted axis (Ark+ / Community) is nearing
      // its term end, so they can convert to a paid subscription before access
      // lapses. Scans Neon membership rows, resolves each recipient's email from
      // Auth0 (membership stores no PII), sends a one-time Resend reminder per
      // (recipient, axis, term-end), and records each send so nobody is nagged
      // twice for the same term.
      path: '/api/cron/gift-expiry-reminders',
      method: ['POST', 'GET'],
      handler: async (req, _res, json) => {
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'not_configured' })
        if (!cronAuthorized(req, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!env.DATABASE_URL) {
          return json(500, { error: 'not_configured' })
        }

        const sql = getDb(env)
        try {
          const summary = await runGiftExpiryReminders({
            env,
            sql,
            appBaseUrl,
            withinDays: GIFT_EXPIRY_REMINDER_DAYS,
            nowMs: Date.now(),
            resolveRecipient: async (sub) => {
              const profile = await getAuth0NameProfile(env, sub)
              if (!profile) return null
              return {
                email: profile.email,
                firstName: greetingFirstName(
                  profile.givenName,
                  profile.email,
                  profile.familyName,
                ),
              }
            },
          })
          json(200, summary)
        } catch (err) {
          console.error('[cron] gift-expiry-reminders failed:', err)
          json(500, { error: 'reminder_run_failed' })
        }
      },
    }),
    defineRoute({
      // Prune expired webhook-dedup markers from both event tables. Monthly
      // Vercel cron; deletes rows older than the retention window so the
      // append-only markers don't grow unbounded. Safe to run any time — a
      // no-op when nothing has aged out. See WEBHOOK_EVENT_RETENTION_DAYS.
      path: '/api/cron/prune-webhook-events',
      method: ['POST', 'GET'],
      handler: async (req, _res, json) => {
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'not_configured' })
        if (!cronAuthorized(req, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!env.DATABASE_URL) {
          return json(500, { error: 'not_configured' })
        }

        const sql = getDb(env)
        try {
          // make_interval binds the day count as a value; RETURNING id lets the
          // driver report each delete's row count for the run summary.
          const stripeDeleted = await sql`
            delete from stripe_webhook_events
            where received_at < now() - make_interval(days => ${WEBHOOK_EVENT_RETENTION_DAYS})
            returning id`
          const scDeleted = await sql`
            delete from sc_webhook_events
            where received_at < now() - make_interval(days => ${WEBHOOK_EVENT_RETENTION_DAYS})
            returning id`
          json(200, { stripe: stripeDeleted.length, sc: scDeleted.length })
        } catch (err) {
          console.error('[cron] prune-webhook-events failed:', err)
          json(500, { error: 'prune_failed' })
        }
      },
    }),
  ]
}
