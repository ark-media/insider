// The gift-expiry reminder email (T7.5). Sent by the reminder cron to a gift
// recipient whose gifted axis (Ark+ or the Fold) is nearing its term end, so
// they can convert to a paid subscription before access lapses. Reuses the Ark+
// brand shell from welcome-email. Pure (no I/O) so it's trivially testable.

import { BRAND_CYAN, esc, renderShell } from './welcome-email.js'

export type GiftExpiryEmailParams = {
  firstName?: string
  // The human label of the expiring axis — 'Ark+' or 'the Fold'. Every
  // sentence below names it mid-phrase ("access to the Fold"), never as a
  // possessive, so a name that carries its own article still reads.
  axisLabel: string
  // The term-end date, already formatted for display and carrying the zone it's
  // stated in (e.g. "August 3, 2026 ET") — a gift term ends at an absolute
  // instant, so a bare date is ambiguous to a reader in another zone.
  expiresOn: string
  // Whole calendar days until the term ends, counted in the same zone as
  // `expiresOn` so the relative and absolute halves of the sentence agree.
  daysRemaining: number
  // Where the CTA lands — the account page, whose per-axis rows carry the actual
  // keep-access / switch-to-bundle actions (T7.3/T7.4/D9).
  accountUrl: string
  // D9: the recipient already holds the OTHER axis via a live subscription, so
  // the nudge is "add this to your plan (the bundle)" rather than a standalone
  // subscribe. Copy-only — the account page owns the mechanic.
  otherAxisSubscribed: boolean
}

// "in 7 days" reads as urgency; the exact date reads as fact. The nudge wants
// both, so the copy states the countdown and then pins it to a dated deadline.
function endsWhen(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'today'
  if (daysRemaining === 1) return 'tomorrow'
  return `in ${daysRemaining} days`
}

export function renderGiftExpiryEmail(p: GiftExpiryEmailParams): {
  subject: string
  html: string
} {
  // Already a clean first name — callers resolve it through greetingFirstName,
  // which is what rejects a name manufactured from the member's email.
  const first = p.firstName?.trim() || undefined
  const axis = esc(p.axisLabel)
  const when = endsWhen(p.daysRemaining)

  // Subject carries the countdown alone — it's read at a glance, and the date
  // would push it past where most clients truncate. The preheader states the
  // date, so the two together give the whole picture in the inbox list.
  const subject = `Your gifted access to ${p.axisLabel} ends ${when}`
  const headlineHtml = `Your gift of ${axis} is ending.`

  const endsSentence = `Your gifted access to ${axis} ends ${when}, on <strong>${esc(p.expiresOn)}</strong>.`

  const bodyHtml = p.otherAxisSubscribed
    ? `${endsSentence} Because you already subscribe, you can keep it by adding ${axis} to your plan — that moves you to the Ark+ &amp; The Fold bundle, so both live on one subscription. Manage it from <a href="${p.accountUrl}" style="color:${BRAND_CYAN};">your account</a>.`
    : `${endsSentence} To keep it going without a gap, subscribe from <a href="${p.accountUrl}" style="color:${BRAND_CYAN};">your account</a> — you'll pick up right where the gift leaves off.`

  const html = renderShell({
    preheader: `Ends ${p.expiresOn}. Keep it going.`,
    eyebrow: 'Your gift is ending',
    headlineHtml,
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml,
    ctaHref: p.accountUrl,
    ctaLabel: p.otherAxisSubscribed ? 'Add it to my plan' : `Keep ${p.axisLabel}`,
    ctaFollowupHtml: `No auto-charge — your gift never renews on its own, so nothing happens unless you choose to continue.`,
    footerHtml:
      'You’re getting this because a gifted membership on your account is about to end. Need help? Just reply to this email.',
  })

  return { subject, html }
}
