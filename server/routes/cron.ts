// Entitlement reconciliation cron. Vercel cron hits this nightly. Three-pass
// sync against Stripe + Auth0 + Circle; see ../entitlement.ts for the
// passes.
//
// Auth: cron requests from Vercel include `Authorization: Bearer
// <CRON_SECRET>` matching the secret set in the project's environment.

import { secretEquals } from '../lib/timing-safe.js'
import { reconcileEntitlements, type ReconcileAxis } from '../entitlement.js'
import { getDb } from '../lib/db.js'
import { getMigrationConfig, getReminderConfig } from '../lib/app-settings.js'
import { runFeedSetupReminders } from '../lib/feed-reminders.js'
import { runFeedMigrationReminders } from '../lib/feed-migration-reminders.js'
import {
  GIFT_EXPIRY_REMINDER_DAYS,
  runGiftExpiryReminders,
} from '../lib/gift-expiry-reminders.js'
import { runWinbackCampaign } from '../lib/winback.js'
import { winbackUnsubUrl } from './winback.js'
import { getAuth0NameProfile } from '../lib/auth0-user.js'
import { greetingFirstName } from '../../shared/profile-name.js'
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
// is dead weight. 90 days dwarfs any Stripe/Beehiiv retry window, so pruning past it
// can never drop a marker that could still match a live retry.
const WEBHOOK_EVENT_RETENTION_DAYS = 90

// Help-widget sessions are kept longer than webhook events because their value
// is a trend — which questions keep going unanswered — not an individual row.
// They still expire: the steps include whatever a member typed into the search
// box, which can carry personal details, so this must not accumulate forever.
const SUPPORT_SESSION_RETENTION_DAYS = 180

export function cronRoutes({ env, stripe, appBaseUrl }: Deps): Route[] {
  // The entitlement reconcile. vercel.json schedules the per-axis paths
  // separately so neither pass's Auth0 lookups can run the other out of the
  // function's time limit; the combined path runs both, for a manual run.
  const reconcileRoute = (path: string, axis?: ReconcileAxis): Route =>
    defineRoute({
      path,
      method: ['POST', 'GET'],
      handler: async (req, _res, json) => {
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'not_configured' })
        if (!cronAuthorized(req, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!stripe) return json(500, { error: 'not_configured' })

        const summary = await reconcileEntitlements(env, stripe, { axis })
        json(200, {
          scanned: summary.scanned,
          arkPlusRemoved: summary.arkPlusRemoved,
          circleDrift: summary.circleDrift,
          circleRemoved: summary.circleRemoved,
          circleDryRun: summary.circleDryRun,
          errors: summary.errors,
        })
      },
    })

  return [
    reconcileRoute('/api/cron/reconcile-entitlements'),
    reconcileRoute('/api/cron/reconcile-entitlements/ark-plus', 'ark-plus'),
    reconcileRoute('/api/cron/reconcile-entitlements/circle', 'circle'),
    defineRoute({
      // Nudge members who started paying but haven't set up their private
      // feed. Scans the premium readers in Neon, sends a one-time Resend
      // reminder to the ones who never activated, and records each send so
      // nobody is nagged twice.
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
      // The feed-migration check-in series: the escalating 30-day / 60-day /
      // final notices sent to members carried over from the old Call Me Back
      // feed who still haven't moved. Distinct from the reminder above — that
      // one counts from a member's join date, this one from two fixed calendar
      // dates. See shared/feed-migration.ts.
      path: '/api/cron/feed-migration-reminders',
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
          const summary = await runFeedMigrationReminders({
            env,
            sql,
            appBaseUrl,
            config: await getMigrationConfig(sql),
            nowMs: Date.now(),
          })
          json(200, summary)
        } catch (err) {
          console.error('[cron] feed-migration-reminders failed:', err)
          json(500, { error: 'migration_run_failed' })
        }
      },
    }),
    defineRoute({
      // Nudge gift recipients whose gifted axis (Ark+ / the Fold) is nearing
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
      // Invite members who left Ark+ six months ago to come back. Scans the
      // cancellation record (which outlives the membership row), skips anyone
      // who has resubscribed or opted out, sends a one-time Resend invitation,
      // and records each send so nobody is mailed twice. See lib/winback.ts.
      path: '/api/cron/winback',
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
          const summary = await runWinbackCampaign({
            env,
            sql,
            appBaseUrl,
            nowMs: Date.now(),
            unsubscribeUrlFor: (email) => winbackUnsubUrl(email, env, appBaseUrl),
          })
          json(200, summary)
        } catch (err) {
          console.error('[cron] winback failed:', err)
          json(500, { error: 'winback_run_failed' })
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
          const beehiivDeleted = await sql`
            delete from beehiiv_webhook_events
            where received_at < now() - make_interval(days => ${WEBHOOK_EVENT_RETENTION_DAYS})
            returning id`
          const supportDeleted = await sql`
            delete from support_conversations
            where created_at < now() - make_interval(days => ${SUPPORT_SESSION_RETENTION_DAYS})
            returning id`
          json(200, {
            stripe: stripeDeleted.length,
            beehiiv: beehiivDeleted.length,
            support: supportDeleted.length,
          })
        } catch (err) {
          console.error('[cron] prune-webhook-events failed:', err)
          json(500, { error: 'prune_failed' })
        }
      },
    }),
  ]
}
