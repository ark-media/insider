// The launch-day "move your feed" email. Sent once, on Oct 5, by
// scripts/feed-move-send.ts to every subscriber who predates launch: their
// membership is now Ark+ (every show, same price), and the one thing they have
// to do is move their podcast feed to the new platform.
//
// The design is the launch mockup, built as table HTML. It deliberately names
// no switch-off date: members should move now, not plan for the deadline. The
// check-in series (feed-migration-email.ts) carries the date for the members
// who don't.
//
// Images are served from the site's own /public/email (and the show covers
// from /public/shows), so `assetBaseUrl` must be a deployment that has them.
// Every headline and fact is live text, so the email still reads with images
// blocked — the hero and the icons only decorate.
//
// Transactional (sent per member, about their own subscription), so there is no
// unsubscribe block or postal address — the footer is the lifecycle emails'.
// Pure (no I/O) so it's trivially testable.

import { ARK_MEDIA_LOGO, eyebrowRows, MANAGE_FOOTER, showRows } from './email-layout.js'

const TOP_BG = '#e1eefc' // matches the hero JPG's own background
const PAGE_BG = '#eff9fe'
const DARK_BG = '#0a1e53'
const INK = '#0b153c' // --color-navy
const FG = '#454c78'
const CYAN = '#3eb5f9' // brand cyan: highlights, and the CTA under navy text
const RULE = '#b9e3fa'
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif"

const BENEFITS = [
  { icon: 'icon-early-access', label: 'Early<br />access' },
  { icon: 'icon-ad-free', label: 'Ad-free<br />listening' },
  { icon: 'icon-exclusive', label: 'Exclusive<br />content' },
  { icon: 'icon-newsletter', label: 'Weekly<br />newsletter' },
] as const

const UNCHANGED = [
  {
    icon: 'icon-price',
    title: 'Same price',
    body: 'You&rsquo;ll get more shows, fewer ads, and exclusive content for the same price you already pay.',
  },
  {
    icon: 'icon-account',
    title: 'Same account',
    body: 'You&rsquo;ll sign in with the same account you already use.',
  },
  {
    icon: 'icon-billing',
    title: 'Same billing',
    body: 'Nothing changes about how you&rsquo;re billed.',
  },
] as const

export type FeedMoveEmailParams = {
  // The setup hub (/setup), wrapped in the member's own auto-login link.
  setupUrl: string
  // Origin serving /email/* and /shows/* — the deployment the links land on.
  assetBaseUrl: string
}

export function renderFeedMoveEmail(p: FeedMoveEmailParams): {
  subject: string
  html: string
} {
  const base = p.assetBaseUrl.replace(/\/+$/, '')
  const img = (path: string) => `${base}/${path}`
  const cyan = (html: string) => `<span style="color:${CYAN};">${html}</span>`

  const benefits = BENEFITS.map(
    (b, i) => `
                    <td width="25%" align="center" valign="top" style="width:25%;padding:0 4px;${i > 0 ? `border-left:1px solid ${CYAN};` : ''}">
                      <img src="${img(`email/${b.icon}.png`)}" alt="" width="40" height="40" style="display:block;width:40px;height:40px;margin:0 auto;border:0;" />
                      <div style="padding-top:10px;font:700 11px/15px ${FONT};letter-spacing:0.5px;text-transform:uppercase;color:${INK};">${b.label}</div>
                    </td>`,
  ).join('')

  const unchanged = UNCHANGED.map(
    (u, i) => `
                  <tr>
                    <td style="padding:20px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ''}">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                        <td width="88" align="center" valign="middle" style="width:88px;">
                          <img src="${img(`email/${u.icon}.png`)}" alt="" width="56" height="56" style="display:block;width:56px;height:56px;margin:0 auto;border:0;" />
                        </td>
                        <td valign="middle" style="padding-left:20px;border-left:1px solid ${CYAN};">
                          <div style="font:800 21px/26px ${FONT};letter-spacing:-0.3px;text-transform:uppercase;color:${INK};">${u.title}</div>
                          <div style="padding-top:4px;font:400 15px/22px ${FONT};color:${FG};">${u.body}</div>
                        </td>
                      </tr></table>
                    </td>
                  </tr>`,
  ).join('')

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
      @media (max-width: 480px) {
        .h1 { font-size: 36px !important; line-height: 38px !important; }
        .h2 { font-size: 30px !important; line-height: 33px !important; }
        .h3 { font-size: 20px !important; line-height: 24px !important; }
        .pad { padding-left: 20px !important; padding-right: 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${PAGE_BG};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Every Ark Media show. More exclusive content. Same price. Here&rsquo;s the one thing to do.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PAGE_BG};">
            <!-- Hero -->
            <tr>
              <td bgcolor="${TOP_BG}" style="background:${TOP_BG};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td class="pad" style="padding:40px 32px 0;">
                      <img src="${ARK_MEDIA_LOGO}" alt="Ark Media" width="150" style="display:block;width:150px;height:auto;border:0;" />
                    </td>
                  </tr>
                  <tr>
                    <td class="pad h1" style="padding:32px 32px 0;font:900 46px/48px ${FONT};letter-spacing:-1.5px;color:${INK};">Your membership<br />just got ${cyan('a lot bigger.')}</td>
                  </tr>
                  <tr>
                    <td class="pad" style="padding:16px 32px 0;font:400 20px/27px ${FONT};color:${INK};">Every Ark Media show. More exclusive content. Same price.</td>
                  </tr>
                  <tr>
                    <td class="pad" style="padding:20px 32px 0;">
                      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="48" style="width:48px;height:1px;line-height:1px;font-size:1px;background:${CYAN};">&nbsp;</td></tr></table>
                    </td>
                  </tr>
                  <tr>
                    <td class="pad" style="padding:14px 32px 0;font:400 18px/24px ${FONT};color:${INK};">Now <strong style="font-weight:900;font-size:22px;letter-spacing:-0.5px;color:${INK};">Ark<span style="color:${CYAN};">+</span></strong></td>
                  </tr>
                  <tr>
                    <td style="padding:20px 0 0;">
                      <img src="${img('email/feed-move-shows.jpg')}" alt="Call me Back, For Heaven&rsquo;s Sake, Ark News Daily, and Chosen People Problems" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;" />
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 16px 32px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>${benefits}
                      </tr></table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="height:4px;line-height:4px;font-size:4px;background:#2b1a4f;">&nbsp;</td>
            </tr>

            <!-- The one thing -->
            <tr>
              <td align="center" class="pad" style="padding:32px 32px 0;font:800 26px/31px ${FONT};letter-spacing:-0.5px;color:${INK};">There&rsquo;s one thing you&rsquo;ll need to do:<br />${cyan('move your feed.')}</td>
            </tr>

            <!-- What you now get -->
            ${eyebrowRows('What you now get')}
            <tr>
              <td align="center" class="pad h2" style="padding:24px 32px 0;font:900 40px/42px ${FONT};letter-spacing:-1.2px;color:${INK};">One membership.<br />The whole ${cyan('network.')}</td>
            </tr>
            <tr>
              <td align="center" class="pad" style="padding:14px 40px 12px;font:400 16px/24px ${FONT};color:${FG};">Early access, ad-free listening, and exclusive content across every show in the network, plus our weekly subscriber-exclusive newsletter.</td>
            </tr>
            ${showRows(base)}

            <!-- What's not changing -->
            ${eyebrowRows('What&rsquo;s not changing')}
            <tr>
              <td class="pad" style="padding:12px 32px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${unchanged}
                </table>
              </td>
            </tr>

            <!-- What you need to do -->
            <tr>
              <td bgcolor="${DARK_BG}" style="background:${DARK_BG};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${eyebrowRows('What you need to do', '#ffffff')}
                  <tr>
                    <td align="center" class="pad" style="padding:22px 32px 0;font:800 26px/32px ${FONT};letter-spacing:-0.5px;color:#ffffff;">Log into your account at <a href="${p.setupUrl}" target="_blank" style="color:${CYAN};text-decoration:none;">arkmedia.org</a> and move your podcast feed to the new platform ${cyan('today.')}</td>
                  </tr>
                  <tr>
                    <td align="center" class="pad" style="padding:14px 40px 0;font:400 16px/24px ${FONT};color:#ffffff;">It should take about 5 minutes. Until you switch, new episodes won&rsquo;t show up in your app.</td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:24px 24px 36px;">
                      <table role="presentation" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center" bgcolor="${CYAN}" style="background:${CYAN};border-radius:8px;">
                            <a href="${p.setupUrl}" target="_blank" style="display:inline-block;padding:16px 56px;font:900 17px/20px ${FONT};letter-spacing:0.3px;text-transform:uppercase;color:${INK};text-decoration:none;border-radius:8px;">Move my feed &rarr;</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Sign-off -->
            <tr>
              <td class="pad" style="padding:36px 32px 0;font:400 16px/24px ${FONT};color:${FG};">Ark Media&rsquo;s mission is to make room for more Jewish voices and perspectives, and Ark+ is the next step in that. We&rsquo;re excited to share it with you. None of this happens without our subscribers, so thank you for your support.</td>
            </tr>
            <tr>
              <td class="pad" style="padding:16px 32px 0;font:800 17px/24px ${FONT};color:${INK};">&mdash; The Ark Media Team</td>
            </tr>
            <tr>
              <td class="pad" style="padding:28px 32px 40px;">
                <p style="margin:0;padding-top:20px;border-top:1px solid ${RULE};font:400 12px/1.6 ${FONT};color:#686e86;">${MANAGE_FOOTER}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  return { subject: 'Your membership just got a lot bigger', html }
}
