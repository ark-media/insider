// The gift-expiry reminder email. Sent by the reminder cron to a gift recipient
// whose gifted Ark+ or Fold access is nearing its end, so they can keep it
// before access lapses. Pure (no I/O) so it's trivially testable.

import { accent, esc, greeting, link, renderShell } from './email-layout.js'

export type GiftExpiryEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  // 'Ark+' or 'the Fold'. Always used mid-phrase ("access to the Fold"), never
  // as a possessive, so a name carrying its own article still reads.
  axisLabel: string
  // The term-end date, formatted with its zone (e.g. "August 3, 2026 ET").
  expiresOn: string
  // Whole calendar days until the term ends, counted in the same zone as
  // `expiresOn` so the two halves of the sentence agree.
  daysRemaining: number
  // The account page, whose rows carry the keep-access actions.
  accountUrl: string
  // The recipient already pays for the OTHER half, so the nudge is "add this to
  // your plan" rather than a standalone subscribe.
  otherAxisSubscribed: boolean
}

// "in 7 days" reads as urgency; the exact date reads as fact. The email gives both.
function endsWhen(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'today'
  if (daysRemaining === 1) return 'tomorrow'
  return `in ${daysRemaining} days`
}

export function renderGiftExpiryEmail(p: GiftExpiryEmailParams): {
  subject: string
  html: string
} {
  const axis = esc(p.axisLabel)
  const when = endsWhen(p.daysRemaining)

  // The subject carries the countdown alone; the preheader adds the date.
  const subject = `Your gifted access to ${p.axisLabel} ends ${when}`

  const keep = p.otherAxisSubscribed
    ? `You already subscribe, so you can add ${axis} to your plan. Both then live on one membership.`
    : `Subscribe from ${link(p.accountUrl, 'your account')} and you&rsquo;ll pick up right where the gift leaves off.`

  const html = renderShell({
    preheader: `Ends ${esc(p.expiresOn)}. Keep it going.`,
    headlineHtml: `Your gift of ${axis} is ${accent('ending.')}`,
    sublineHtml: 'Keep it going without a gap.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      `Your gifted access to ${axis} ends ${when}, on <strong>${esc(p.expiresOn)}</strong>. ${keep}`,
      'Gifts never renew on their own, so nothing is charged unless you choose to continue.',
    ],
    action: {
      href: p.accountUrl,
      label: p.otherAxisSubscribed ? 'Add it to my plan' : `Keep ${axis}`,
    },
    footerHtml:
      'You&rsquo;re getting this because a gifted membership on your account is about to end. Need help? Just reply to this email.',
  })

  return { subject, html }
}
