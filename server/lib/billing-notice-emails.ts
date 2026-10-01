// Three billing notices:
//
//   - access ended: the membership has actually stopped (the cancellation email
//     went out weeks earlier, at the moment of cancelling);
//   - card updated: a security notice after the card on file changes;
//   - renewal reminder: 30 days before an annual membership renews.
//
// Pure (no I/O) so they're trivially testable; callers hand the result to
// sendEmail().

import {
  accent,
  esc,
  greeting,
  link,
  MANAGE_FOOTER,
  renderShell,
  supportLine,
} from './email-layout.js'
import { TIER_EMAIL_LABEL, type CancellableTier } from './cancellation-email.js'

// ---------------------------------------------------------------------------
// Access ended
// ---------------------------------------------------------------------------

export type AccessEndedEmailParams = {
  firstName?: string
  // What stopped. For a Bundle whose Fold half is still held by a gift, this
  // is only the Ark+ half: the email names what the member actually lost.
  tier: CancellableTier
  // Why Stripe ended the subscription. 'payment_failed' is Stripe's own
  // cancellation_details.reason once its retries run out; everything else
  // reads as a plain end.
  reason: 'payment_failed' | 'ended'
  // Where to rejoin: the Ark+ pricing page, or the Fold page for a Fold-only
  // member.
  rejoinUrl: string
}

// What they no longer have, one sentence per tier.
const WHAT_STOPPED: Record<CancellableTier, string> = {
  'ark-plus':
    'Early access, ad-free listening, and exclusive content have ended. You&rsquo;re back on the free, ad-supported shows.',
  circle: 'You no longer have access to the Fold.',
  bundle:
    'Your Ark+ benefits and your Fold access have ended. You&rsquo;re back on the free, ad-supported shows.',
}

export function renderAccessEndedEmail(p: AccessEndedEmailParams): {
  subject: string
  html: string
} {
  const label = TIER_EMAIL_LABEL[p.tier]
  const subject = `Your ${label} membership has ended`
  const failed = p.reason === 'payment_failed'

  const html = renderShell({
    preheader: esc(subject),
    headlineHtml: `Your ${esc(label)} membership has ${accent('ended.')}`,
    sublineHtml: failed
      ? 'We couldn&rsquo;t take payment after several tries.'
      : 'You won&rsquo;t be charged again.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [WHAT_STOPPED[p.tier], failed ? `Think this is a mistake? ${supportLine()}` : supportLine()],
    action: {
      headingHtml: `Come back ${accent('any time.')}`,
      bodyHtml: failed ? 'Rejoining takes a minute, with a card that works.' : 'Rejoining takes a minute.',
      href: p.rejoinUrl,
      label: 'Rejoin',
    },
    footerHtml:
      'You&rsquo;re getting this because your membership ended. You won&rsquo;t be charged again. Need help? Just reply to this email.',
  })

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Card updated
// ---------------------------------------------------------------------------

export type CardUpdatedEmailParams = {
  firstName?: string
  // "Visa" / "Mastercard", already display-cased. Null when the new method
  // isn't a card we can describe, and the copy then says "your payment method".
  brand: string | null
  last4: string | null
  accountUrl: string
}

export function renderCardUpdatedEmail(p: CardUpdatedEmailParams): {
  subject: string
  html: string
} {
  const card =
    p.brand && p.last4
      ? `${esc(p.brand)} ending in ${esc(p.last4)}`
      : p.last4
        ? `the card ending in ${esc(p.last4)}`
        : null

  const html = renderShell({
    preheader: 'The card on your membership was changed.',
    headlineHtml: `Your payment card was ${accent('updated.')}`,
    sublineHtml: 'Nothing else about your membership has changed.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      card
        ? `Your membership will now be charged to your ${card}.`
        : 'The payment method on your membership was updated.',
      // The reason this email exists: a change the member didn't make.
      '<strong>Didn&rsquo;t make this change?</strong> Reply to this email right away and we&rsquo;ll look into it.',
    ],
    action: { href: p.accountUrl, label: 'View billing' },
    footerHtml:
      'You&rsquo;re getting this because the payment method on your membership changed. Need help? Just reply to this email.',
  })

  return { subject: 'Your payment card was updated', html }
}

// ---------------------------------------------------------------------------
// Annual renewal reminder
// ---------------------------------------------------------------------------

export type RenewalReminderEmailParams = {
  firstName?: string
  tier: CancellableTier
  // The renewal date, already formatted with its zone (e.g. "October 14, 2026 ET").
  renewsOn: string
  // What the renewal will charge, already formatted in the subscription's
  // currency, taxes and discounts included (Stripe's preview of the invoice).
  amount: string
  accountUrl: string
}

// Auto-renewal laws (California's among them) ask for notice before a yearly
// plan renews, saying when, for how much, and how to cancel. All three are in
// the body, not the small print.
export function renderRenewalReminderEmail(p: RenewalReminderEmailParams): {
  subject: string
  html: string
} {
  const label = TIER_EMAIL_LABEL[p.tier]
  const subject = `Your ${label} membership renews on ${p.renewsOn}`

  const html = renderShell({
    preheader: esc(`Your annual ${label} membership renews on ${p.renewsOn}.`),
    headlineHtml: `Your annual membership renews ${accent('soon.')}`,
    sublineHtml: 'There&rsquo;s nothing you need to do to keep it.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      `Your annual ${esc(label)} membership renews automatically on <strong>${esc(p.renewsOn)}</strong>, and we&rsquo;ll charge <strong>${esc(p.amount)}</strong> to the card on file.`,
      `Rather not renew? Cancel from ${link(p.accountUrl, 'your account')} any time before then and you won&rsquo;t be charged.`,
    ],
    action: { href: p.accountUrl, label: 'Manage membership' },
    closingHtml: `Thank you for supporting Ark Media. ${supportLine()}`,
    footerHtml: MANAGE_FOOTER,
  })

  return { subject, html }
}
