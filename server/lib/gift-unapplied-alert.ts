// Staff alert: a redeemed gift whose Stripe half didn't happen.
//
// A gift that overlaps a paid subscription acts inside Stripe — it extends the
// subscription, or (a single-tier gift on a Bundle sub) credits the customer
// balance. When that step is skipped or fails, the gift is still spent and the
// recipient has nothing to show for it. The cases:
//   currency_mismatch  the gift was paid in a different currency from the sub;
//                      a balance only pays invoices in its own currency, and
//                      there is no honest exchange rate to credit at
//   no_amount          the gift row has no captured amount to credit
//   credit_failed      Stripe refused or errored on the balance credit
//   extend_failed      Stripe refused or errored on the extension
// Rare by design, so a person resolves it by hand (a refund to the buyer, or a
// manual extension) — this email is how they find out.
//
// Soft-fail like every send: the redemption already stands.

import { escapeHtml } from '../../shared/validation.js'
import { contactEmails } from '../../src/config/urls.js'
import { sendEmail } from './email.js'
import type { GiftRow } from './membership.js'
import { stripeCustomerUrl } from './stripe-dashboard.js'

export type GiftUnappliedReason =
  | 'currency_mismatch'
  | 'no_amount'
  | 'credit_failed'
  | 'extend_failed'

const REASON_TEXT: Record<GiftUnappliedReason, string> = {
  currency_mismatch:
    "The gift was paid in a different currency from the recipient's subscription, so it could not become account credit.",
  no_amount: 'The gift has no recorded payment amount, so there was nothing to credit.',
  credit_failed: 'Stripe refused or failed the account credit.',
  extend_failed: "Stripe refused or failed the subscription extension.",
}

export function renderGiftUnappliedAlert(p: {
  reason: GiftUnappliedReason
  gift: Pick<GiftRow, 'redemption_token' | 'tier' | 'plan' | 'amount_cents' | 'currency'>
  recipientEmail: string
  subscriptionCurrency: string | null
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  stripeSecretKey: string | undefined
}): { subject: string; html: string } {
  const paid =
    p.gift.amount_cents != null
      ? `${p.gift.amount_cents} (minor units) ${(p.gift.currency ?? 'usd').toUpperCase()}`
      : 'unknown'
  const rows: Array<[string, string]> = [
    ['Recipient', p.recipientEmail],
    ['Gift', `${p.gift.tier}, ${p.gift.plan ?? 'unknown term'}`],
    ['Paid', paid],
    ['Subscription currency', p.subscriptionCurrency?.toUpperCase() ?? 'unknown'],
    ['Stripe subscription', p.stripeSubscriptionId ?? 'none'],
    // The token is spent (the gift is redeemed), so it is only a lookup key now.
    ['Gift token', p.gift.redemption_token],
  ]
  const customerLink = p.stripeCustomerId
    ? `<p><a href="${escapeHtml(stripeCustomerUrl(p.stripeCustomerId, p.stripeSecretKey))}">Open the customer in Stripe</a></p>`
    : ''
  const html =
    `<p>A gift was redeemed but not applied to the recipient's subscription. ` +
    `They were told the team will apply it by hand.</p>` +
    `<p><strong>Why:</strong> ${escapeHtml(REASON_TEXT[p.reason])}</p>` +
    `<table>${rows
      .map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`)
      .join('')}</table>` +
    customerLink +
    `<p>To resolve it, refund the gift buyer or extend the recipient's subscription by hand.</p>`
  return { subject: `Gift needs manual handling: ${p.recipientEmail}`, html }
}

export async function sendGiftUnappliedAlert(
  env: Record<string, string>,
  p: Omit<Parameters<typeof renderGiftUnappliedAlert>[0], 'stripeSecretKey'>,
): Promise<boolean> {
  const { subject, html } = renderGiftUnappliedAlert({
    ...p,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
  })
  return sendEmail(env, {
    to: contactEmails.support,
    subject,
    html,
    // One alert per gift, however many times the redemption path is re-entered.
    idempotencyKey: `gift_unapplied_${p.gift.redemption_token}`,
  })
}
