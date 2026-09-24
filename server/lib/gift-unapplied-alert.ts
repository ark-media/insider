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
//   zero_paid          the gift was paid at $0 (a 100%-off code) — no money to
//                      credit back
//   no_list_price      no gift price exists in the subscription's currency
//   currency_unknown   the subscription's currency couldn't be read from Stripe
//   no_customer        the membership has no Stripe customer to credit
//   price_lookup_failed  the Stripe gift-price lookup errored
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
  | 'zero_paid'
  | 'no_list_price'
  | 'currency_unknown'
  | 'no_customer'
  | 'price_lookup_failed'
  | 'credit_failed'
  | 'extend_failed'

const REASON_TEXT: Record<GiftUnappliedReason, string> = {
  currency_mismatch:
    "The gift was paid in a different currency from the recipient's subscription, so it could not become account credit.",
  no_amount: 'The gift has no recorded payment amount, so there was nothing to credit.',
  zero_paid:
    'The gift was paid at 0 (for example with a 100%-off code), so there is no money to credit back.',
  no_list_price:
    "There is no gift price in the subscription's currency, so the credit could not be capped safely.",
  currency_unknown: "Stripe couldn't be reached to read the subscription's currency.",
  no_customer: "The recipient's membership has no Stripe customer to credit.",
  price_lookup_failed: 'The gift price lookup in Stripe failed.',
  credit_failed: 'Stripe refused or failed the account credit.',
  extend_failed: "Stripe refused or failed the subscription extension.",
}

// What to do about it. A refund only makes sense when the buyer paid something.
const RESOLUTION_TEXT: Record<GiftUnappliedReason, string> = {
  currency_mismatch: "Refund the gift buyer, or extend the recipient's subscription by hand.",
  no_amount: "Check the payment in Stripe, then refund the gift buyer or extend the recipient's subscription by hand.",
  zero_paid:
    "There is nothing to refund. If the gift should still count, extend the recipient's subscription by hand.",
  no_list_price: "Refund the gift buyer, or extend the recipient's subscription by hand.",
  currency_unknown: "Credit the recipient's balance or extend their subscription by hand, or refund the gift buyer.",
  no_customer: "Find the recipient's Stripe customer, then credit or extend by hand, or refund the gift buyer.",
  price_lookup_failed:
    "Credit the recipient's balance or extend their subscription by hand, or refund the gift buyer.",
  credit_failed: "Credit the recipient's balance by hand, or refund the gift buyer.",
  extend_failed: "Extend the recipient's subscription by hand, or refund the gift buyer.",
}

export function renderGiftUnappliedAlert(p: {
  reason: GiftUnappliedReason
  // True when the recipient was shown the gift as held for the team. False when
  // part of it was granted, so they were shown it as active and don't know the
  // rest is pending.
  recipientToldPending: boolean
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
    (p.recipientToldPending
      ? `They were told the team will apply it by hand.</p>`
      : `Part of the gift was granted, so they were shown it as active and don't know ` +
        `this part is pending. Let them know once it's sorted.</p>`) +
    `<p><strong>Why:</strong> ${escapeHtml(REASON_TEXT[p.reason])}</p>` +
    `<table>${rows
      .map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`)
      .join('')}</table>` +
    customerLink +
    `<p><strong>To resolve it:</strong> ${escapeHtml(RESOLUTION_TEXT[p.reason])}</p>`
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
