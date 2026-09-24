// The ICMB launch welcome-offer email. Sent once, on launch day, by
// scripts/welcome-offer-send.ts to every Ark+ subscriber who predates launch,
// inviting them onto the Bundle at the welcome price for their own cadence.
//
// The price is stated in the member's own currency and cadence — the same
// figures /offer quotes — so nobody reads $20 in the email and a different
// number on the page. Pure (no I/O) so it's trivially testable.
//
// COPY: placeholder wording pending the copy doc. The facts in it (price, term,
// deadline) are the offer's own and are not placeholders.

import {
  ARK_MEDIA_TEAM,
  MANAGE_FOOTER,
  esc,
  renderShell,
} from './welcome-email.js'
import { WELCOME_OFFER_CLOSES_LABEL } from '../../shared/welcome-offer.js'

export type WelcomeOfferEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  plan: 'monthly' | 'yearly'
  // Pre-formatted in the subscription's currency: the offer and the list price.
  offerPrice: string
  bundlePrice: string
  discountedMonths: number
  // The auto-login link to /offer. Seeing the offer needs only this; taking it
  // asks for a real sign-in, because it charges the card on file.
  offerUrl: string
}

export function renderWelcomeOfferEmail(p: WelcomeOfferEmailParams): {
  subject: string
  html: string
} {
  const first = p.firstName?.trim() || undefined
  const offer = esc(p.offerPrice)
  const list = esc(p.bundlePrice)
  const terms =
    p.plan === 'yearly'
      ? `${offer} for your first year (then ${list} a year)`
      : `${offer} a month for your first ${p.discountedMonths} months (then ${list} a month)`

  const html = renderShell({
    preheader: `Add the Fold to your membership for ${offer}${p.plan === 'yearly' ? ' for the year' : ' a month'}. Open until ${WELCOME_OFFER_CLOSES_LABEL}.`,
    eyebrow: 'A welcome offer',
    headlineHtml: 'Add the Fold to your membership.',
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml:
      'Thank you for being with us from the start. Today we&rsquo;re opening the Fold, our members&rsquo; community, and as an existing subscriber you can move to the bundle &mdash; Ark+ and the Fold together &mdash; at a welcome price.',
    bodySecondHtml: `The bundle is yours at ${terms}. You keep your ${p.plan === 'yearly' ? 'annual' : 'monthly'} plan, and the offer is open until ${WELCOME_OFFER_CLOSES_LABEL}.`,
    ctaHref: p.offerUrl,
    ctaLabel: 'See your offer',
    ctaFollowupHtml:
      'You&rsquo;ll see exactly what&rsquo;s due today before anything is charged. Nothing changes unless you confirm.',
    signoffHtml: `Thank you for your support.<br />&mdash; ${ARK_MEDIA_TEAM}`,
    footerHtml: MANAGE_FOOTER,
  })

  return { subject: 'Your welcome offer: add the Fold', html }
}
