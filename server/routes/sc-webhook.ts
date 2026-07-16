// Inbound webhook from Supporting Cast.
//
// SC surfaces feed activation only via webhooks — the MembershipFeed REST
// object has no activation field — so this endpoint captures `feed.activated`
// and `feed.access_revoked` and mirrors them into sc_feed_activations, which
// powers the setup hub's progress count and the reminder cron.
//
// Auth: SC's webhook config doesn't support custom headers, so (like the
// Beehiiv webhook) we gate on a shared secret in the query string. Register:
//   https://<APP_BASE_URL>/api/sc/webhook?key=$SC_WEBHOOK_SECRET
// and subscribe to feed.activated + feed.access_revoked. The `?key=` value can
// leak into upstream access logs; the blast radius of a leaked key is bounded —
// an attacker could only flip a member's UI checkmark and suppress/allow a
// reminder email, never grant entitlement (Simplecast remains the paid signal).

import crypto from 'node:crypto'
import { getDb } from '../lib/db.js'
import {
  recordFeedActivated,
  recordFeedRevoked,
} from '../lib/feed-activations.js'
import { makeJsonRes, readBody } from '../lib/http.js'
import type { Deps, Route } from '../lib/route.js'

// SC webhook envelope. Field names are defensive: the payload nests the member
// and feed, and we've seen `event`/`event_type` used interchangeably across
// SC's docs, so accept either.
type ScWebhookEvent = {
  event?: string
  event_type?: string
  event_id?: string
  timestamp?: string | null
  activated_at?: string | null
  revoked_at?: string | null
  member?: { email?: string } | null
  feed?: { id?: number | string } | null
}

function eventType(e: ScWebhookEvent): string {
  return (e.event ?? e.event_type ?? '').trim()
}

// Parse the feed id defensively — it arrives as a number or a numeric string,
// and must be a positive integer before we key a row on it.
function parseFeedId(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null
  return n
}

export function scWebhookRoutes({ env }: Deps): Route[] {
  return [
    {
      path: '/api/sc/webhook',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

        const secret = env.SC_WEBHOOK_SECRET
        if (!secret) return json(500, { error: 'SC_WEBHOOK_SECRET missing' })
        const url = new URL(req.url ?? '', 'http://x')
        const got = Buffer.from(url.searchParams.get('key') ?? '')
        const want = Buffer.from(secret)
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
          return json(401, { error: 'unauthorized' })
        }

        // No DB → nothing to mirror. Ack so SC doesn't retry against a
        // deployment that simply isn't wired for activation tracking.
        if (!env.DATABASE_URL) return json(200, { received: true })
        const sql = getDb(env)

        // Parse the body ourselves so the constant-time key check runs first.
        const raw = await readBody(req)
        let event: ScWebhookEvent
        try {
          event = JSON.parse(raw.toString('utf8')) as ScWebhookEvent
        } catch {
          return json(400, { error: 'invalid_json' })
        }

        const type = eventType(event)
        const email = event.member?.email?.trim()
        const feedId = parseFeedId(event.feed?.id)

        // Nothing to key on — ack so SC doesn't retry a payload we can't use.
        if (!email || feedId === null) {
          console.warn('[sc] webhook missing member email or feed id', { type })
          return json(200, { received: true, skipped: 'incomplete' })
        }

        // Idempotency: claim event_id before doing work. Unlike Stripe the
        // write itself is an idempotent upsert, so a missing event_id (SC omits
        // it) is fine — we just process without dedupe. A ledger error is
        // non-fatal; fall through and process.
        if (event.event_id) {
          try {
            const rows = await sql`
              insert into sc_webhook_events (id, type)
              values (${event.event_id}, ${type})
              on conflict (id) do nothing
              returning id`
            if (rows.length === 0) {
              return json(200, { received: true, deduped: true })
            }
          } catch (err) {
            console.error('[sc] webhook idempotency ledger failed:', err)
          }
        }

        try {
          if (type === 'feed.activated') {
            const at = event.activated_at ?? event.timestamp ?? null
            await recordFeedActivated(sql, email, feedId, at)
          } else if (type === 'feed.access_revoked') {
            const at = event.revoked_at ?? event.timestamp ?? null
            await recordFeedRevoked(sql, email, feedId, at)
          } else {
            // A subscribed-but-unhandled event type. Ack so SC stops retrying.
            return json(200, { received: true, skipped: 'unhandled_type' })
          }
          json(200, { received: true })
        } catch (err) {
          console.error('[sc] webhook handler failed:', err)
          json(500, { error: 'webhook_handler_failed' })
        }
      },
    },
  ]
}
