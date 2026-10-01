// The shared layout for every member email, in the launch emails' design: a
// light-blue hero with the Ark Media logo and a 900-weight headline that ends
// on a cyan payoff, a pale body with centred, eyebrowed sections, a navy action
// band holding the one button, and the team's sign-off.
//
// Light palette only — an email can't follow the site's theme toggle — and
// solid hex throughout, because Outlook drops rgba(). Every fact is live text:
// most clients block images by default, so the logo, show covers and icons
// only decorate.
//
// Pure (no I/O) so everything built on it is trivially testable.

import { contactEmails } from '../../src/config/urls.js'
import { shows } from '../../src/data/shows.js'

const TOP_BG = '#e1eefc' // the hero band; matches public/email/feed-move-shows.jpg
const PAGE_BG = '#eff9fe'
const DARK_BG = '#0a1e53'
const INK = '#0b153c' // --color-navy
const FG = '#454c78'
const CYAN = '#3eb5f9' // brand cyan: payoffs, rules, and the button under navy text
// Brand cyan fails AA as text on the pale body, so links there use the darker
// light-theme cyan; the payoff words are 900-weight display type, which passes.
const LINK = '#0a6fad'
const RULE = '#b9e3fa'
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif"

// Exported for the small print in emails with their own layout.
export const BRAND_FG_MUTED = '#686e86'

export const ARK_MEDIA_LOGO =
  'https://beehiiv-images-production.s3.amazonaws.com/uploads/asset/file/d50e9e46-101e-4927-8937-d7e3a8008942/Ark_Media_-_Dark__2___1_.png?t=1790188765'

// Minimal HTML escaping for user-supplied values interpolated into the body
// (names, personal messages). Keeps a stray "<" or "&" from breaking markup.
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The cyan payoff that ends a headline: "Your membership just got <accent>". */
export function accent(html: string): string {
  return `<span style="color:${CYAN};">${html}</span>`
}

export function link(href: string, label: string): string {
  return `<a href="${href}" style="color:${LINK};">${label}</a>`
}

// The salutation. The name is already a clean first name (callers resolve it
// through greetingFirstName); without one the email opens "Hi there,".
export function greeting(firstName: string | undefined): string {
  const first = firstName?.trim()
  return first ? `Hi ${esc(first)},` : 'Hi there,'
}

// support@arkmedia.org is deliberately not on the ARK_DOMAIN — see
// contactEmails.support.
export const SUPPORT_EMAIL = contactEmails.support

export function supportLine(): string {
  return `Need a hand? Email ${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)}.`
}

const ARK_MEDIA_TEAM = 'The Ark Media Team'
export const MANAGE_FOOTER =
  'Manage your membership anytime from your account. Need help? Just reply to this email.'

// ---------------------------------------------------------------------------
// The network's shows, as the launch email lists them
// ---------------------------------------------------------------------------

// One line per show, in the launch email's words. The list itself comes from
// src/data/shows.ts, so a show joining the network appears without an edit
// here (with its tagline until it gets a line of its own).
const SHOW_BLURB: Record<string, string> = {
  'call-me-back': 'Dan Senor unpacks the news shaping Israel and the Jewish world.',
  'for-heavens-sake':
    'Donniel Hartman and Yossi Klein Halevi model honest disagreement about Israel and Jewish life.',
  'ark-news-daily': 'A fast, trustworthy catch-up on the stories that matter each morning.',
  'chosen-people-problems':
    'Yael and Chaya Leah take on the sacred, political, and familial chaos of Jewish life.',
}
const NEW_SHOWS = new Set(['chosen-people-problems'])

/**
 * Cover-and-blurb rows for every network show, alternating sides. `assetBase`
 * is the origin serving /shows/*; without one the rows are text only.
 */
export function showRows(assetBase: string | null): string {
  const base = assetBase?.replace(/\/+$/, '') ?? null
  return shows
    .filter((s) => !s.paid)
    .map((s, i) => {
      const flip = i % 2 === 1
      const title = esc(s.title)
      const coverPath = s.coverArt?.replace(/\.jpg$/, '-400.jpg')
      const cover =
        base && coverPath
          ? `
                    <td width="42%" valign="middle" style="width:42%;padding:${flip ? '0 0 0 12px' : '0 12px 0 0'};">
                      <img src="${base}${coverPath}" alt="${title}" width="200" style="display:block;width:100%;max-width:200px;height:auto;border:1px solid ${RULE};${flip ? 'margin-left:auto;' : ''}" />
                    </td>`
          : ''
      const badge = NEW_SHOWS.has(s.slug)
        ? `<div style="padding-bottom:8px;"><span style="display:inline-block;padding:3px 10px;border-radius:10px;white-space:nowrap;background:#cdeafc;font:700 9px/14px ${FONT};letter-spacing:2px;text-transform:uppercase;color:${LINK};">New from Ark Media</span></div>`
        : ''
      const text = `
                    <td valign="middle" style="padding:${cover ? (flip ? '0 12px 0 0' : '0 0 0 12px') : '0'};">
                      ${badge}<div class="h3" style="font:800 24px/28px ${FONT};letter-spacing:-0.5px;color:${INK};">${title}</div>
                      <div style="padding-top:8px;font:400 15px/22px ${FONT};color:${FG};">${SHOW_BLURB[s.slug] ?? esc(s.tagline)}</div>
                    </td>`
      return `
            <tr>
              <td class="pad" style="padding:0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${i > 0 ? `border-top:1px solid ${RULE};` : ''}">
                  <tr>
                    <td style="padding:20px 0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${flip ? text + cover : cover + text}</tr></table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
    })
    .join('')
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/** Centred spaced capitals over a short cyan rule — the launch emails' section label. */
export function eyebrowRows(label: string, color = INK): string {
  return `
            <tr>
              <td align="center" style="padding:36px 24px 0;font:500 12px/16px ${FONT};letter-spacing:4px;text-transform:uppercase;color:${color};">${label}</td>
            </tr>
            <tr>
              <td align="center" style="padding:12px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="64" style="width:64px;height:1px;line-height:1px;font-size:1px;background:${CYAN};">&nbsp;</td></tr></table></td>
            </tr>`
}

export type EmailItem = { title: string; bodyHtml: string }

export type EmailSection = {
  eyebrow?: string
  headingHtml?: string
  // Centred, under the heading.
  introHtml?: string
  // Left-aligned body copy.
  paragraphs?: string[]
  // "What's not changing"-style rows: a capitalised title over one line.
  items?: EmailItem[]
  // The network's show list (covers need an absolute action href to resolve).
  shows?: boolean
  // A quoted note, e.g. a gift's personal message.
  note?: { label: string; bodyHtml: string }
}

type EmailAction = {
  eyebrow?: string
  headingHtml?: string
  bodyHtml?: string
  href: string
  label: string
}

export type ShellParams = {
  preheader: string // hidden preview text; caller pre-escapes
  // Small cyan capitals above the headline.
  kicker?: string
  headlineHtml: string // caller pre-escapes any user content
  sublineHtml?: string
  greetingHtml?: string
  bodyHtml?: string[]
  sections?: EmailSection[]
  action: EmailAction
  // A closing paragraph above "— The Ark Media Team".
  closingHtml?: string
  footerHtml: string
}

const para = (html: string, pad = '0 32px 16px') =>
  `
            <tr>
              <td class="pad" style="padding:${pad};font:400 16px/24px ${FONT};color:${FG};">${html}</td>
            </tr>`

// The origin the email's links land on, which also serves the show covers.
// Every action href is an absolute app URL in production (an auto-login link
// or the account page); a relative one just means no covers.
function originOf(href: string): string | null {
  try {
    return new URL(href).origin
  } catch {
    return null
  }
}

function renderSection(s: EmailSection, assetBase: string | null): string {
  let out = s.eyebrow ? eyebrowRows(s.eyebrow) : ''
  if (s.headingHtml) {
    out += `
            <tr>
              <td align="center" class="pad h2" style="padding:${s.eyebrow ? '22px' : '36px'} 32px 0;font:900 32px/36px ${FONT};letter-spacing:-1px;color:${INK};">${s.headingHtml}</td>
            </tr>`
  }
  if (s.introHtml) {
    out += `
            <tr>
              <td align="center" class="pad" style="padding:14px 40px 4px;font:400 16px/24px ${FONT};color:${FG};">${s.introHtml}</td>
            </tr>`
  }
  const opened = s.eyebrow || s.headingHtml || s.introHtml
  if (s.paragraphs?.length) {
    out += s.paragraphs.map((p, i) => para(p, `${i === 0 && opened ? '20px' : '0'} 32px 16px`)).join('')
  }
  if (s.items?.length) {
    out += `
            <tr>
              <td class="pad" style="padding:8px 32px 8px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${s.items
                  .map(
                    (it, i) => `
                  <tr>
                    <td style="padding:16px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ''}">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                        <td style="padding-left:20px;border-left:2px solid ${CYAN};">
                          <div style="font:800 18px/24px ${FONT};letter-spacing:-0.2px;text-transform:uppercase;color:${INK};">${it.title}</div>
                          <div style="padding-top:4px;font:400 15px/22px ${FONT};color:${FG};">${it.bodyHtml}</div>
                        </td>
                      </tr></table>
                    </td>
                  </tr>`,
                  )
                  .join('')}
                </table>
              </td>
            </tr>`
  }
  if (s.shows) out += showRows(assetBase)
  if (s.note) {
    out += `
            <tr>
              <td class="pad" style="padding:8px 32px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${CYAN};background:#ffffff;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 6px;font:700 11px/16px ${FONT};letter-spacing:2px;text-transform:uppercase;color:${LINK};">${s.note.label}</p>
                      <p style="margin:0;font:italic 400 16px/24px ${FONT};color:${INK};">${s.note.bodyHtml}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
  }
  return out
}

export function renderShell(p: ShellParams): string {
  const assetBase = originOf(p.action.href)
  const a = p.action
  const kicker = p.kicker
    ? `
                  <tr>
                    <td class="pad" style="padding:28px 32px 0;font:700 12px/16px ${FONT};letter-spacing:3px;text-transform:uppercase;color:${LINK};">${p.kicker}</td>
                  </tr>`
    : ''
  const subline = p.sublineHtml
    ? `
                  <tr>
                    <td class="pad" style="padding:14px 32px 0;font:400 19px/26px ${FONT};color:${INK};">${p.sublineHtml}</td>
                  </tr>`
    : ''
  const greet = p.greetingHtml ? para(p.greetingHtml, '32px 32px 16px') : ''
  const body = (p.bodyHtml ?? []).map((b, i) => para(b, `${i === 0 && !greet ? '32px' : '0'} 32px 16px`)).join('')
  const sections = (p.sections ?? []).map((s) => renderSection(s, assetBase)).join('')
  const closing = p.closingHtml ? para(p.closingHtml, '36px 32px 0') : ''

  return `<!doctype html>
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
      @media (max-width: 480px) {
        .h1 { font-size: 34px !important; line-height: 37px !important; }
        .h2 { font-size: 28px !important; line-height: 32px !important; }
        .h3 { font-size: 20px !important; line-height: 24px !important; }
        .pad { padding-left: 20px !important; padding-right: 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${PAGE_BG};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${p.preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PAGE_BG};">
            <tr>
              <td bgcolor="${TOP_BG}" style="background:${TOP_BG};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td class="pad" style="padding:40px 32px 0;">
                      <img src="${ARK_MEDIA_LOGO}" alt="Ark Media" width="150" style="display:block;width:150px;height:auto;border:0;" />
                    </td>
                  </tr>${kicker}
                  <tr>
                    <td class="pad h1" style="padding:${p.kicker ? '12px' : '32px'} 32px 0;font:900 42px/45px ${FONT};letter-spacing:-1.3px;color:${INK};">${p.headlineHtml}</td>
                  </tr>${subline}
                  <tr>
                    <td class="pad" style="padding:22px 32px 36px;">
                      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="48" style="width:48px;height:1px;line-height:1px;font-size:1px;background:${CYAN};">&nbsp;</td></tr></table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="height:4px;line-height:4px;font-size:4px;background:#2b1a4f;">&nbsp;</td>
            </tr>${greet}${body}${sections}
            <tr>
              <td style="padding-top:28px;">&nbsp;</td>
            </tr>
            <tr>
              <td bgcolor="${DARK_BG}" style="background:${DARK_BG};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${a.eyebrow ? eyebrowRows(a.eyebrow, '#ffffff') : ''}${
                  a.headingHtml
                    ? `
                  <tr>
                    <td align="center" class="pad" style="padding:${a.eyebrow ? '22px' : '36px'} 32px 0;font:800 26px/32px ${FONT};letter-spacing:-0.5px;color:#ffffff;">${a.headingHtml}</td>
                  </tr>`
                    : ''
                }${
                  a.bodyHtml
                    ? `
                  <tr>
                    <td align="center" class="pad" style="padding:14px 40px 0;font:400 16px/24px ${FONT};color:#ffffff;">${a.bodyHtml}</td>
                  </tr>`
                    : ''
                }
                  <tr>
                    <td align="center" style="padding:${a.eyebrow || a.headingHtml || a.bodyHtml ? '24px' : '36px'} 24px 36px;">
                      <table role="presentation" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center" bgcolor="${CYAN}" style="background:${CYAN};border-radius:8px;">
                            <a href="${a.href}" target="_blank" style="display:inline-block;padding:16px 40px;font:900 16px/20px ${FONT};letter-spacing:0.3px;text-transform:uppercase;color:${INK};text-decoration:none;border-radius:8px;">${a.label} &rarr;</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>${closing}
            <tr>
              <td class="pad" style="padding:${closing ? '16px' : '36px'} 32px 0;font:800 17px/24px ${FONT};color:${INK};">&mdash; ${ARK_MEDIA_TEAM}</td>
            </tr>
            <tr>
              <td class="pad" style="padding:28px 32px 40px;">
                <p style="margin:0;padding-top:20px;border-top:1px solid ${RULE};font:400 12px/1.6 ${FONT};color:${BRAND_FG_MUTED};">${p.footerHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}
