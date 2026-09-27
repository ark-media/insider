// Three billing notices with no entry in the "Lifecycle Emails & Member
// Communications" doc, so their wording is written here, modelled on the
// cancellation and failed-payment copy:
//
//   - access ended: the membership has actually stopped (the cancellation email
//     went out weeks earlier, at the moment of cancelling);
//   - card updated: a security notice after the card on file changes;
//   - renewal reminder: 30 days before an annual membership renews.
//
// Pure (no I/O) so they're trivially testable; callers hand the result to
// sendEmail().

import {
  ARK_MEDIA_TEAM,
  esc,
  link,
  renderShell,
  supportLine,
} from './welcome-email.js'
import { TIER_EMAIL_LABEL, type CancellableTier } from './cancellation-email.js'

function greeting(firstName: string | undefined): string {
  const first = firstName?.trim()
  return first ? `Hi ${esc(first)},` : 'Hi there,'
}

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
  // (a cancel landing at period end, a Dashboard cancel) reads as a plain end.
  reason: 'payment_failed' | 'ended'
  // Where to rejoin: the Ark+ pricing page, or the Fold page for a Fold-only
  // member.
  rejoinUrl: string
}

// What they no longer have, one sentence per tier.
const WHAT_STOPPED: Record<CancellableTier, string> = {
  'ark-plus':
    'Ad-free listening, early access and exclusive content have ended, and you&rsquo;re back on the free, ad-supported version of our shows.',
  circle: 'You no longer have access to the Fold.',
  bundle:
    'Your Ark+ benefits have ended, so you&rsquo;re back on the free, ad-supported version of our shows, and you no longer have access to the Fold.',
}

export function renderAccessEndedEmail(p: AccessEndedEmailParams): {
  subject: string
  html: string
} {
  const label = TIER_EMAIL_LABEL[p.tier]
  const subject = `Your ${label} membership has ended`
  const why =
    p.reason === 'payment_failed'
      ? `We weren&rsquo;t able to take payment after several tries, so your ${esc(label)} membership has ended.`
      : `Your ${esc(label)} membership has now ended.`

  const html = renderShell({
    preheader: esc(subject),
    eyebrow: 'Membership ended',
    headlineHtml: `${esc(subject)}.`,
    greetingHtml: greeting(p.firstName),
    bodyHtml: why,
    bodySecondHtml: WHAT_STOPPED[p.tier],
    ctaHref: p.rejoinUrl,
    ctaLabel: 'Rejoin',
    ctaFollowupHtml:
      p.reason === 'payment_failed'
        ? `Rejoining takes a minute, with a card that works. ${supportLine('If you think this is a mistake')}`
        : supportLine('If you have any questions'),
    signoffHtml: ARK_MEDIA_TEAM,
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
    eyebrow: 'Account notice',
    headlineHtml: 'Your payment card was updated.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: card
      ? `Your membership will now be charged to your ${card}.`
      : 'The payment method on your membership was updated.',
    // The reason this email exists: a change the member didn't make.
    bodySecondHtml: `If you didn&rsquo;t make this change, reply to this email or write to us right away and we&rsquo;ll look into it.`,
    ctaHref: p.accountUrl,
    ctaLabel: 'View billing',
    ctaFollowupHtml: 'Nothing else about your membership has changed.',
    signoffHtml: ARK_MEDIA_TEAM,
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
// the first two paragraphs, not the small print.
export function renderRenewalReminderEmail(p: RenewalReminderEmailParams): {
  subject: string
  html: string
} {
  const label = TIER_EMAIL_LABEL[p.tier]
  const subject = `Your ${label} membership renews on ${p.renewsOn}`

  const html = renderShell({
    preheader: esc(`Your annual ${label} membership renews on ${p.renewsOn}.`),
    eyebrow: 'Renewal reminder',
    headlineHtml: `Your annual membership renews soon.`,
    greetingHtml: greeting(p.firstName),
    bodyHtml: `Your annual ${esc(label)} membership will renew automatically on <strong>${esc(p.renewsOn)}</strong>, and we&rsquo;ll charge <strong>${esc(p.amount)}</strong> to the card on file.`,
    bodySecondHtml: `There&rsquo;s nothing you need to do to keep your membership. If you&rsquo;d rather not renew, you can cancel from ${link(p.accountUrl, 'your account')} any time before then and you won&rsquo;t be charged.`,
    ctaHref: p.accountUrl,
    ctaLabel: 'Manage membership',
    ctaFollowupHtml: `Thank you for supporting Ark Media. ${supportLine('If you have any questions')}`,
    signoffHtml: ARK_MEDIA_TEAM,
    footerHtml:
      'You&rsquo;re getting this because your annual membership is set to renew. Need help? Just reply to this email.',
  })

  return { subject, html }
}
