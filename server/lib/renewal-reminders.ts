// Annual renewal reminder cron logic. Emails every yearly member once, 30 days
// before their membership renews, with the date, the amount and how to cancel.
// Auto-renewal laws (California's among them) ask for this notice on yearly
// plans, 15 to 45 days ahead; 30 sits inside that window with room for a
// missed run.
//
// The decision core (isReminderCandidate) is pure so it's unit-testable
// without the DB, Stripe, Auth0 or email. The orchestrator wires it to the
// roster query, the per-renewal ledger, Stripe's invoice preview (the real
// amount, discounts and tax included), the Auth0 recipient lookup (membership
// stores no PII), and the send.

import type { Sql } from './db.js'
import {
  getAnnualRenewalsWithin,
  recordRenewalReminderSent,
  renewalReminderSent,
  type AnnualRenewalRow,
} from './membership.js'
import { EMAIL_TIME_ZONE, formatTimestampInZone } from '../../shared/format-date.js'
import { renderRenewalReminderEmail } from './billing-notice-emails.js'
import type { CancellableTier } from './cancellation-email.js'
import { formatMinorUnits } from './pricing.js'
import { sendEmail, withEmailUtm } from './email.js'

type Env = Record<string, string>

export const RENEWAL_REMINDER_DAYS = 30

// The tier the renewal is FOR: a booked debundle renews as the product kept.
function renewingTier(row: AnnualRenewalRow): CancellableTier | null {
  const t = row.scheduled_tier ?? row.tier
  return t === 'ark-plus' || t === 'circle' || t === 'bundle' ? t : null
}

// Pure: whether this row gets a reminder. A pending switch to monthly means the
// period end starts a monthly plan, not another year, so there's no annual
// renewal to announce.
export function isReminderCandidate(row: AnnualRenewalRow): boolean {
  if (row.pending_plan && row.pending_plan !== 'yearly') return false
  return renewingTier(row) !== null
}

export type RenewalReminderSummary = {
  scanned: number
  eligible: number
  sent: number
  failed: number
}

export async function runRenewalReminders(deps: {
  env: Env
  sql: Sql
  appBaseUrl: string
  withinDays: number
  // What the renewal invoice will charge, in the subscription's currency.
  // Production: Stripe's invoice preview for the subscription. Null when it
  // can't be read, and the reminder waits for the next run rather than state
  // a wrong amount.
  quoteRenewal: (subscriptionId: string) => Promise<{ amountMinor: number; currency: string } | null>
  resolveRecipient: (sub: string) => Promise<{ email: string | null; firstName?: string } | null>
  send?: (
    env: Env,
    msg: { to: string; subject: string; html: string; idempotencyKey?: string },
  ) => Promise<boolean>
}): Promise<RenewalReminderSummary> {
  const { env, sql, appBaseUrl, withinDays, quoteRenewal, resolveRecipient } = deps
  const send = deps.send ?? sendEmail
  const rows = await getAnnualRenewalsWithin(sql, withinDays)
  let eligible = 0
  let sent = 0
  let failed = 0

  for (const row of rows) {
    if (!isReminderCandidate(row)) continue
    const tier = renewingTier(row)!
    const periodEnd = new Date(row.current_period_end).toISOString()
    // Ledger first: a renewal already reminded costs no Stripe or Auth0 call.
    if (await renewalReminderSent(sql, row.stripe_subscription_id, periodEnd)) continue
    eligible++

    // Soft failures leave the ledger untouched, so the next daily run retries.
    const quote = await quoteRenewal(row.stripe_subscription_id)
    const recipient = quote ? await resolveRecipient(row.auth0_sub) : null
    const email = recipient?.email ?? null
    if (!quote || !email) {
      failed++
      continue
    }

    const { subject, html } = renderRenewalReminderEmail({
      firstName: recipient?.firstName,
      tier,
      renewsOn: formatTimestampInZone(periodEnd, EMAIL_TIME_ZONE, 'long', { withZoneLabel: true }),
      amount: formatMinorUnits(quote.amountMinor, quote.currency),
      accountUrl: withEmailUtm(`${appBaseUrl}/account/billing`, 'renewal-reminder'),
    })
    const ok = await send(env, {
      to: email,
      subject,
      html,
      idempotencyKey: `renewal_reminder_${row.stripe_subscription_id}_${periodEnd}`,
    })
    if (ok) {
      await recordRenewalReminderSent(sql, row.stripe_subscription_id, periodEnd)
      sent++
    } else {
      failed++
    }
  }

  return { scanned: rows.length, eligible, sent, failed }
}
