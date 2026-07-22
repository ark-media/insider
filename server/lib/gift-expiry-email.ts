// The gift-expiry reminder email (T7.5). Sent by the reminder cron to a gift
// recipient whose gifted axis (Ark+ or Community) is nearing its term end, so
// they can convert to a paid subscription before access lapses. Reuses the Ark+
// brand shell from welcome-email. Pure (no I/O) so it's trivially testable.

import { BRAND_CYAN, esc, renderShell } from './welcome-email.js'

export type GiftExpiryEmailParams = {
  firstName?: string
  // The human label of the expiring axis — 'Ark+' or 'Community'.
  axisLabel: string
  // The term-end date, already formatted for display (e.g. "August 3, 2026").
  expiresOn: string
  // Where the CTA lands — the account page, whose per-axis rows carry the actual
  // keep-access / switch-to-bundle actions (T7.3/T7.4/D9).
  accountUrl: string
  // D9: the recipient already holds the OTHER axis via a live subscription, so
  // the nudge is "add this to your plan (the bundle)" rather than a standalone
  // subscribe. Copy-only — the account page owns the mechanic.
  otherAxisSubscribed: boolean
}

export function renderGiftExpiryEmail(p: GiftExpiryEmailParams): {
  subject: string
  html: string
} {
  const first = p.firstName?.trim().split(' ')[0] || undefined
  const axis = esc(p.axisLabel)

  const subject = `Your gifted ${p.axisLabel} access ends ${p.expiresOn}`
  const headlineHtml = `Your ${axis} gift is ending.`

  const bodyHtml = p.otherAxisSubscribed
    ? `Your gifted ${axis} access ends on <strong>${esc(p.expiresOn)}</strong>. Because you already subscribe, you can keep it by adding ${axis} to your plan — that moves you to the Ark+ &amp; Community bundle, so both live on one subscription. Manage it from <a href="${p.accountUrl}" style="color:${BRAND_CYAN};">your account</a>.`
    : `Your gifted ${axis} access ends on <strong>${esc(p.expiresOn)}</strong>. To keep it going without a gap, subscribe from <a href="${p.accountUrl}" style="color:${BRAND_CYAN};">your account</a> — you'll pick up right where the gift leaves off.`

  const html = renderShell({
    preheader: `Your ${p.axisLabel} access ends ${p.expiresOn}. Keep it going.`,
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
