// The ICMB launch welcome-offer email. Sent once, on launch day, by
// scripts/welcome-offer-send.ts to every Ark+ subscriber who predates launch,
// inviting them onto the Bundle at the welcome price for their own cadence.
//
// The price is stated in the member's own currency and cadence — the same
// figures /offer quotes — so nobody reads $20 in the email and a different
// number on the page. Pure (no I/O) so it's trivially testable.
//
// Layout is the launch announcement's own (banner art over a single CTA), not
// renderShell's card: the banner carries the headline. The price paragraph
// stays in text because most clients block images by default, and a reader
// who sees only the button would otherwise have no idea what it claims.
//
// Transactional (sent per member, to their own subscription), so there is no
// unsubscribe block or postal address — the footer is the lifecycle emails'.

import {
  BRAND_FG_MUTED,
  MANAGE_FOOTER,
  esc,
} from './welcome-email.js'
import { WELCOME_OFFER_CLOSES_LABEL } from '../../shared/welcome-offer.js'

// [data-theme="light"] tokens from src/index.css, flattened to hex for Outlook.
const PAPER = '#eef3fc' // --color-navy-900 (light): the page canvas
const INK = '#0b153c' // --color-navy
const FG = '#373f5f' // --color-fg
const RULE = '#dddee4' // --color-rule
// The site's primary CTA: brand cyan with navy text (7.6:1), as on /offer.
const CTA_BG = '#3eb5f9'
// --font-display / --font-sans.
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif"

// The launch banner, hosted on Resend. Alt text restates it for blocked images.
export const WELCOME_OFFER_BANNER_URL =
  'https://resend-attachments.s3.amazonaws.com/9oRhukv-HFodR6l2HbSdkt/a4113a72-d356-469e-ba36-6f046789c997'
const BANNER_ALT =
  'Ark Media announces that their membership has gotten bigger with more exclusive content for the same price.'

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
  const preheader = `Add the Fold to your membership for ${offer}${p.plan === 'yearly' ? ' for the year' : ' a month'}. Open until ${WELCOME_OFFER_CLOSES_LABEL}.`
  const para = (html: string, margin = '0 0 16px') =>
    `<p style="margin:${margin};font:400 16px/1.6 ${FONT};color:${FG};">${html}</p>`

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <style>
      :root { color-scheme: light; supported-color-schemes: light; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${PAPER};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td>
                <img src="${WELCOME_OFFER_BANNER_URL}" alt="${esc(BANNER_ALT)}" width="600" style="display:block;width:100%;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:8px;" />
              </td>
            </tr>
            <tr>
              <td style="padding:32px 8px 8px;">
                ${para(first ? `Hi ${esc(first)},` : 'Hi there,')}
                ${para('Thank you for being with us from the start. Today we&rsquo;re opening the Fold, our members&rsquo; community, and as an existing subscriber you can move to the bundle &mdash; Ark+ and the Fold together &mdash; at a welcome price.')}
                ${para(`The bundle is yours at <strong style="color:${INK};">${terms}</strong>. You keep your ${p.plan === 'yearly' ? 'annual' : 'monthly'} plan, and the offer is open until ${WELCOME_OFFER_CLOSES_LABEL}.`, '0')}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 8px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="background:${CTA_BG};">
                      <a href="${p.offerUrl}" target="_blank" style="display:inline-block;padding:16px 36px;font:700 14px/1 ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:${INK};text-decoration:none;">Claim your offer to join the Fold &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 8px 32px;">
                <p style="margin:0;font:400 13px/1.6 ${FONT};color:${BRAND_FG_MUTED};">You&rsquo;ll see exactly what&rsquo;s due today before anything is charged. Nothing changes unless you confirm.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 8px 0;border-top:1px solid ${RULE};">
                <p style="margin:0;font:400 12px/1.6 ${FONT};color:${BRAND_FG_MUTED};">${MANAGE_FOOTER}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  return { subject: 'Your welcome offer: add the Fold', html }
}
