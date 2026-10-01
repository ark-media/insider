// The failed-payment (dunning) email. Sent from the Stripe webhook when an
// invoice for a live membership doesn't go through, so the member can fix the
// card before Stripe's retries run out and the subscription is cancelled.
//
// Pure (no I/O) so it's trivially testable.

import { accent, esc, greeting, renderShell, supportLine } from './email-layout.js'
import { TIER_EMAIL_LABEL, type CancellableTier } from './cancellation-email.js'

export type PaymentFailedEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  // Null when the membership row can't be read, and the copy then says "your
  // membership" rather than naming the wrong product.
  tier: CancellableTier | null
  // Where the card gets replaced — /account/billing.
  updateCardUrl: string
}

export function renderPaymentFailedEmail(p: PaymentFailedEmailParams): {
  subject: string
  html: string
} {
  const product = p.tier
    ? `your ${esc(TIER_EMAIL_LABEL[p.tier])} membership`
    : 'your membership'

  const html = renderShell({
    preheader: 'Update your payment method to keep your membership active.',
    headlineHtml: `There&rsquo;s a problem with your ${accent('payment.')}`,
    sublineHtml: 'Your membership is still active, for now.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      `We tried to charge your card for ${product}, and it didn&rsquo;t go through.`,
      // Almost every one of these is an expired card; a member who thinks
      // something is wrong with their account behaves very differently.
      'This usually means a card expired, was replaced, or your bank flagged the charge. It&rsquo;s rarely anything serious.',
    ],
    action: {
      eyebrow: 'What you need to do',
      headingHtml: `Update your payment ${accent('method.')}`,
      bodyHtml: 'It takes a minute. If we can&rsquo;t process payment, your access will be paused.',
      href: p.updateCardUrl,
      label: 'Update payment method',
    },
    closingHtml: supportLine(),
    footerHtml:
      'You&rsquo;re getting this because a payment for your membership failed. Once it goes through, we&rsquo;ll stop sending these. Need help? Just reply to this email.',
  })

  return { subject: "We couldn't process your payment", html }
}
