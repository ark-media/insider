// Gift-expiry reminder cron logic (T7.5). Scans Neon membership rows for gifted
// axes (Ark+ / Community) whose term ends inside the reminder window and emails
// the recipient a one-time nudge to convert to a paid subscription before access
// lapses. A per-(recipient, axis, term-end) ledger prevents double-nagging.
//
// The decision core (candidatesForRow) is a pure function so it's unit-testable
// without the DB, Auth0, or email. The orchestrator wires it to the roster query,
// per-candidate ledger lookups, the Auth0 email resolution (membership stores no
// PII), and the send.

import type { Sql } from './db.js'
import { deriveEntitlements } from '../entitlement.js'
import {
  getGiftAxesExpiringWithin,
  giftExpiryReminderSent,
  recordGiftExpiryReminderSent,
  type GiftExpiryRow,
} from './membership.js'
import {
  EMAIL_TIME_ZONE,
  calendarDaysUntilInZone,
  formatTimestampInZone,
} from '../../shared/format-date.js'
import { renderGiftExpiryEmail } from './gift-expiry-email.js'
import { sendEmail } from './email.js'

type Env = Record<string, string>

// The near-expiry window — matches the account-settings banner (T7.4) so the
// in-app nudge and the email fire on the same horizon.
export const GIFT_EXPIRY_REMINDER_DAYS = 14

type AxisKey = 'ark_plus' | 'circle'

const AXES: {
  key: AxisKey
  col: 'ark_plus_gift_expires_at' | 'circle_gift_expires_at'
  other: AxisKey
  label: string
}[] = [
  { key: 'ark_plus', col: 'ark_plus_gift_expires_at', other: 'circle', label: 'Ark+' },
  { key: 'circle', col: 'circle_gift_expires_at', other: 'ark_plus', label: 'Community' },
]

// Is this axis backed by the row's LIVE subscription (not the gift)? If so its
// gift column — if any — isn't what's ending, so never remind. Also detects the
// D9 case (the OTHER axis held via a subscription → offer the bundle switch).
function axisIsSubBacked(row: GiftExpiryRow, key: AxisKey): boolean {
  if (!row.stripe_subscription_id) return false
  const ent = deriveEntitlements(row.tier)
  return key === 'ark_plus' ? ent.arkPlus : ent.circle
}

export type GiftExpiryCandidate = {
  auth0_sub: string
  axis: AxisKey
  axisLabel: string
  expiresAt: string // ISO term-end
  otherAxisSubscribed: boolean
}

// Pure: expand a membership row into the axis reminders it warrants — a gift term
// ending inside (now, now + withinDays] on an axis that isn't subscription-backed.
// Ledger + send state is applied by the orchestrator.
export function candidatesForRow(
  row: GiftExpiryRow,
  withinDays: number,
  nowMs: number,
): GiftExpiryCandidate[] {
  const out: GiftExpiryCandidate[] = []
  for (const a of AXES) {
    const iso = row[a.col]
    if (!iso) continue
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) continue
    const days = (ms - nowMs) / 86_400_000
    if (days <= 0 || days > withinDays) continue
    if (axisIsSubBacked(row, a.key)) continue
    out.push({
      auth0_sub: row.auth0_sub,
      axis: a.key,
      axisLabel: a.label,
      expiresAt: iso,
      otherAxisSubscribed: axisIsSubBacked(row, a.other),
    })
  }
  return out
}

// Rendered on the server, where there is no viewer whose timezone we could use
// and the host clock is UTC — which would date the line a day ahead for a US
// member. Pin the zone explicitly instead of inheriting the host's, and name it
// in the output so a member reading from elsewhere isn't left guessing.
function fmtDate(iso: string): string {
  return formatTimestampInZone(iso, EMAIL_TIME_ZONE, 'long', { withZoneLabel: true })
}

export type GiftExpiryReminderSummary = {
  scanned: number
  eligible: number
  sent: number
  failed: number
}

export async function runGiftExpiryReminders(deps: {
  env: Env
  sql: Sql
  appBaseUrl: string
  withinDays: number
  nowMs: number
  // Injected so tests don't touch Auth0. In production this is
  // getAuth0NameProfile(env, sub) — membership stores no PII, so both the
  // recipient's address and their name are resolved from their Auth0 sub at send
  // time, in the one lookup this always had to make.
  resolveRecipient: (
    sub: string,
  ) => Promise<{ email: string | null; firstName?: string } | null>
  // Injectable for tests; defaults to the real Resend sender.
  send?: (env: Env, msg: { to: string; subject: string; html: string }) => Promise<boolean>
}): Promise<GiftExpiryReminderSummary> {
  const { env, sql, appBaseUrl, withinDays, nowMs, resolveRecipient } = deps
  const send = deps.send ?? sendEmail
  const rows = await getGiftAxesExpiringWithin(sql, withinDays)
  const accountUrl = `${appBaseUrl}/account`
  let eligible = 0
  let sent = 0
  let failed = 0

  for (const row of rows) {
    for (const c of candidatesForRow(row, withinDays, nowMs)) {
      // Ledger first — a term already reminded is skipped without an Auth0 call.
      if (await giftExpiryReminderSent(sql, c.auth0_sub, c.axis, c.expiresAt)) continue
      eligible++

      const recipient = await resolveRecipient(c.auth0_sub)
      const email = recipient?.email ?? null
      if (!email) {
        // Can't reach the recipient — leave the ledger untouched so a later run
        // (once Auth0 is reachable) retries rather than silently dropping them.
        failed++
        continue
      }

      const { subject, html } = renderGiftExpiryEmail({
        firstName: recipient?.firstName,
        axisLabel: c.axisLabel,
        expiresOn: fmtDate(c.expiresAt),
        // Counted in the same zone the date is stated in, so "in 7 days" and
        // the date can't contradict each other.
        daysRemaining: calendarDaysUntilInZone(c.expiresAt, nowMs, EMAIL_TIME_ZONE) ?? 0,
        accountUrl,
        otherAxisSubscribed: c.otherAxisSubscribed,
      })
      const ok = await send(env, { to: email, subject, html })
      if (ok) {
        await recordGiftExpiryReminderSent(sql, c.auth0_sub, c.axis, c.expiresAt)
        sent++
      } else {
        // Soft-fail: leave the ledger untouched so the next run retries.
        failed++
      }
    }
  }

  return { scanned: rows.length, eligible, sent, failed }
}
