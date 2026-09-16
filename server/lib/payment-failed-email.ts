// The failed-payment (dunning) email. Sent from the Stripe webhook when an
// invoice for a live membership doesn't go through, so the member can fix the
// card before Stripe's retries run out and the subscription is cancelled.
//
// Copy is the "Lifecycle Emails & Member Communications" doc, "Payment
// Processing Error". Its [PRODUCT NAME] placeholder is the member's tier label.
//
// Pure (no I/O) so it's trivially testable.

import {
  ARK_MEDIA_TEAM,
  esc,
  renderShell,
  supportLine,
} from './welcome-email.js'
import { TIER_EMAIL_LABEL, type CancellableTier } from './cancellation-email.js'

export type PaymentFailedEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  // [PRODUCT NAME]. Null when the membership row can't be read, and the copy
  // then says "your membership" rather than naming the wrong product.
  tier: CancellableTier | null
  // Where the card gets replaced — /account/billing, which carries the
  // on-site Payment Element (not the Stripe portal).
  updateCardUrl: string
}

export function renderPaymentFailedEmail(p: PaymentFailedEmailParams): {
  subject: string
  html: string
} {
  const first = p.firstName?.trim() || undefined
  // "your Ark+ membership" / "your membership" — the article and the noun live
  // here so an unknown tier degrades to a sentence that still reads.
  const product = p.tier
    ? `your ${esc(TIER_EMAIL_LABEL[p.tier])} membership`
    : 'your membership'

  const html = renderShell({
    preheader: 'Update your payment method to keep your membership active.',
    eyebrow: 'Action needed',
    headlineHtml: "There's a problem with your payment.",
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml: `We tried to charge your card for ${product}, and it didn&rsquo;t go through.`,
    // Defusing the alarm is the job of the second paragraph: almost every one of
    // these is an expired card, and a member who thinks something is wrong with
    // their account behaves very differently from one who thinks it's their bank.
    bodySecondHtml:
      'This usually happens because a card expired, got replaced, or your bank flagged the charge for review. It&rsquo;s rarely anything serious.',
    ctaHref: p.updateCardUrl,
    ctaLabel: 'Update payment method',
    ctaFollowupHtml: `Your membership and benefits are still active for now, but if we can&rsquo;t process payment, your access will be paused. ${supportLine()}`,
    signoffHtml: ARK_MEDIA_TEAM,
    footerHtml:
      'You’re getting this because a payment for your membership failed. Once it goes through, we’ll stop sending these. Need help? Just reply to this email.',
  })

  return { subject: "We couldn't process your payment", html }
}
