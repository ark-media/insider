// The ICMB launch welcome-offer email: the Fold announcement, as sent to
// existing Ark+ subscribers. Sent once, the day after launch (Oct 6), by
// scripts/welcome-offer-send.ts to every Ark+ subscriber who predates launch,
// inviting them onto the Bundle at the welcome price.
//
// The design is the Fold launch email (the designer's hand-off HTML, images
// hosted on Beehiiv) with its "How to join" section replaced by the subscriber
// offer: "You're already halfway there". Both cadences' prices are quoted, in
// the member's own currency — the same figures /offer quotes — and the
// member's own plan is the one they get, so nobody reads one number here and a
// different one on the page. Pure (no I/O) so it's trivially testable.
//
// Transactional (sent per member, to their own subscription), so there is no
// unsubscribe block or postal address — the footer is the lifecycle emails'.

import { BRAND_FG_MUTED, esc, MANAGE_FOOTER } from './email-layout.js'
import { WELCOME_OFFER_CLOSES_LABEL } from '../../shared/welcome-offer.js'

// The hand-off's style rules: navy, one accent blue for every highlight and
// button, and Helvetica Neue everywhere with 900-weight headlines.
const NAVY = '#0B1A3F'
const ACCENT = '#005DB8'
const PAGE_BG = '#F1F4F9'
const HERO_BG = '#F1FAFE'
const CARD_BG = '#E3EEF9'
const FONT = "'Helvetica Neue',Helvetica,sans-serif"

const ASSET = 'https://beehiiv-images-production.s3.amazonaws.com/uploads/asset/file'
const IMG = {
  foldLogo: `${ASSET}/633618f6-6752-46b6-abce-14ebb27bef59/The_Fold_-_Logo_-_Positive.png?t=1790779776`,
  arkMediaLogo: `${ASSET}/d50e9e46-101e-4927-8937-d7e3a8008942/Ark_Media_-_Dark__2___1_.png?t=1790188765`,
  heroPhones: `${ASSET}/a114b037-4ff5-48cf-9471-1d8cc1bc388f/fold-hero-phones.jpg?t=1790787170`,
  topicsWaves: `${ASSET}/37447d18-3d9c-4861-b1ae-a3b26c3687a1/fold-waves-topics.jpg?t=1790787479`,
  offerWaves: `${ASSET}/5646bdf5-951f-4acb-9326-0fe2e66b6943/fold-waves-join.jpg?t=1790787474`,
  ohCalendar: `${ASSET}/90bb34f0-db72-4e17-9ad3-00e5b8350236/oh-calendar__1_.png?t=1790779924`,
  ohTeam: `${ASSET}/814ea644-af24-4457-8a7e-534a4939356e/oh-team__1_.png?t=1790779924`,
  ohChat: `${ASSET}/293879c6-b59a-40dc-bfbd-c3efe301e2c2/oh-chat__1_.png?t=1790779924`,
}

const TOPICS = [
  { icon: '8c3124b6-e002-4bc5-a922-cfd6a7a44a55/topic-israel__1_.png', label: 'Israeli policy and diaspora standing' },
  { icon: '3ad3ef34-70a2-4fa6-b744-cc8021d46d9d/topic-security__1_.png', label: 'Israel&rsquo;s security' },
  { icon: 'd7956ba7-2644-460c-84fc-9a0da479f4e7/topic-antisemitism__1_.png', label: 'Rising antisemitism' },
  { icon: 'fb4d3ebb-81c0-457f-a223-566fca836b16/topic-politics__1_.png', label: 'American politics' },
  { icon: '8a6a31e6-63a9-4aac-8b1e-29093f0585c9/topic-challah__1_.png', label: 'A good challah recipe' },
  { icon: '91e4fc14-bf81-4b80-bc5f-c1c9a8f638c5/topic-tv__1_.png', label: 'A show everyone is talking about' },
  { icon: '0aabfdfc-e03c-45fb-9184-8d823fd6da77/topic-joke__1_.png', label: 'A joke only the ten of you will get' },
] as const

type WelcomeOfferPrices = {
  // Pre-formatted in the subscription's currency: the offer and the list price.
  offerPrice: string
  bundlePrice: string
}

export type WelcomeOfferEmailParams = {
  monthly: WelcomeOfferPrices
  yearly: WelcomeOfferPrices
  discountedMonths: number
  // The auto-login link to /offer, signed for the 'welcome_offer' purpose.
  // Seeing the offer needs only this; so does taking it for the first 48 hours
  // after the send, and a real sign-in after that, because it charges the card
  // on file.
  offerUrl: string
  // The Fold page, where the Open House sessions are listed.
  openHouseUrl: string
}

const text = (size: number, line: number, weight = 400) =>
  `font-family:${FONT};font-size:${size}px;line-height:${line}px;font-weight:${weight};color:${NAVY};`

// A label centred between two 1px rules — the hand-off's section divider.
function ruledLabel(labelHtml: string, labelStyle: string, padding: string): string {
  const rule = `<td width="50%" valign="middle"><div style="height:1px;line-height:1px;font-size:1px;background:${NAVY};">&nbsp;</div></td>`
  return `
  <tr>
    <td style="padding:${padding};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>${rule}<td valign="middle" style="padding:0 14px;white-space:nowrap;${labelStyle}">${labelHtml}</td>${rule}</tr>
      </table>
    </td>
  </tr>`
}

const eyebrow = (label: string, padding: string) =>
  ruledLabel(label, `${text(12, 16)}letter-spacing:3px;`, padding)

function topicChip(t: (typeof TOPICS)[number]): string {
  return `
          <td width="50%" valign="top" style="width:50%;padding:0 5px 10px 5px;">
            <table role="presentation" width="100%" height="136" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:100%;height:136px;background:#FFFFFF;border-radius:16px;border-collapse:separate;">
              <tr>
                <td align="center" valign="middle" height="136" style="height:136px;padding:12px 10px;">
                  <img src="${ASSET}/${t.icon}?t=1790779924" alt="" width="50" height="50" style="display:block;width:50px;height:50px;margin:0 auto;border:0;">
                  <div style="padding-top:8px;${text(14, 18)}">${t.label}</div>
                </td>
              </tr>
            </table>
          </td>`
}

function priceCard(label: string, price: string, term: string, then: string): string {
  return `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD_BG}" style="width:100%;background:${CARD_BG};border-radius:12px;border-collapse:separate;">
                  <tr>
                    <td align="center" style="padding:18px 8px;">
                      <div style="${text(10, 14)}letter-spacing:2px;">${label}</div>
                      <div style="padding-top:8px;${text(26, 30, 700)}color:${ACCENT};">${price}</div>
                      <div style="padding-top:4px;${text(14, 18, 700)}">${term}</div>
                      <div style="padding-top:6px;${text(13, 18)}color:${BRAND_FG_MUTED};">${then}</div>
                    </td>
                  </tr>
                </table>`
}

function openHouseColumn(icon: string, title: string, body: string, borders = ''): string {
  return `
          <td width="33%" align="center" valign="top" style="width:33%;padding:0 4px;${borders}">
            <img src="${icon}" alt="" width="80" height="80" style="display:block;width:80px;height:80px;margin:0 auto;border:0;">
            <div style="padding-top:12px;${text(19, 24, 900)}">${title}</div>
            <div style="padding-top:6px;${text(14, 20)}">${body}</div>
          </td>`
}

function button(href: string, label: string, radius: number, maxWidth: number): string {
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${maxWidth}px;border-collapse:collapse;">
        <tr>
          <td align="center" bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:${radius}px;">
            <a href="${href}" target="_blank" style="display:block;padding:18px 12px;font-family:${FONT};font-size:14px;line-height:20px;letter-spacing:1.5px;color:#FFFFFF;text-decoration:none;border-radius:${radius}px;"><strong style="color:#FFFFFF;">${label} &rarr;</strong></a>
          </td>
        </tr>
      </table>`
}

// A section whose wave art sits behind its bottom edge. The URL goes in both
// the attribute and the CSS, as the hand-off does: each covers clients the
// other doesn't. Outlook for Windows shows neither and falls back to PAGE_BG.
function wavesSection(image: string, rows: string): string {
  return `
  <tr>
    <td background="${image}" bgcolor="${PAGE_BG}" valign="top" style="background-color:${PAGE_BG};background-image:url('${image}');background-repeat:no-repeat;background-position:center bottom;background-size:100% auto;padding:0 0 56px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rows}
      </table>
    </td>
  </tr>`
}

export function renderWelcomeOfferEmail(p: WelcomeOfferEmailParams): {
  subject: string
  html: string
} {
  const m = { offer: esc(p.monthly.offerPrice), list: esc(p.monthly.bundlePrice) }
  const y = { offer: esc(p.yearly.offerPrice), list: esc(p.yearly.bundlePrice) }
  const preheader = `Add the Fold to your Ark+ membership from ${m.offer} a month. Offer ends ${WELCOME_OFFER_CLOSES_LABEL}.`

  const chipRows = [0, 2, 4]
    .map((i) => `\n        <tr>${topicChip(TOPICS[i]!)}${topicChip(TOPICS[i + 1]!)}\n        </tr>`)
    .join('')

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
  <body style="margin:0;padding:0;background:${PAGE_BG};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;background:${PAGE_BG};border-collapse:collapse;">
<tr>
<td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:600px;margin:0 auto;background:${PAGE_BG};border-collapse:collapse;">

  <!-- ===== HEADER ===== -->
  <tr>
    <td align="center" bgcolor="${HERO_BG}" style="padding:32px 24px 0 24px;background:${HERO_BG};">
      <img src="${IMG.foldLogo}" alt="The Fold" width="230" style="display:block;width:230px;max-width:70%;height:auto;margin:0 auto;border:0;">
    </td>
  </tr>
  <tr>
    <td bgcolor="${HERO_BG}" style="padding:16px 16px 0 16px;background:${HERO_BG};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td width="50%" valign="middle"><div style="height:1px;line-height:1px;font-size:1px;background:${NAVY};">&nbsp;</div></td>
          <td valign="middle" style="padding:0 8px 0 10px;white-space:nowrap;${text(10, 16)}letter-spacing:1.5px;">A NEW COMMUNITY FROM</td>
          <td valign="middle" style="padding:0 10px 0 0;white-space:nowrap;">
            <img src="${IMG.arkMediaLogo}" alt="Ark Media" width="76" style="display:block;width:76px;height:auto;border:0;">
          </td>
          <td width="50%" valign="middle"><div style="height:1px;line-height:1px;font-size:1px;background:${NAVY};">&nbsp;</div></td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" bgcolor="${HERO_BG}" style="background:${HERO_BG};padding:22px 24px 0 24px;${text(38, 42, 900)}letter-spacing:-1px;">Keep the<br>conversation going</td>
  </tr>
  <tr>
    <td bgcolor="${HERO_BG}" style="background:${HERO_BG};padding:22px 36px 0 36px;${text(17, 26)}">
      Hi, it&rsquo;s Dan.<br>
      For years now, I&rsquo;ve heard from so many of you after an episode of Call me Back ends that you want to keep talking about what you just heard. Argue about it. Ask a question we didn&rsquo;t get to. Tell us how it compares to what you&rsquo;re seeing where you live. There&rsquo;s never really been a place for us to do that together, so we built one. It&rsquo;s called The Fold.
    </td>
  </tr>
  <tr>
    <td align="center" bgcolor="${HERO_BG}" style="padding:20px 0 0 0;background:${HERO_BG};">
      <img src="${IMG.heroPhones}" alt="The Fold app on two phones" width="600" style="display:block;width:100%;max-width:600px;height:auto;margin:0 auto;border:0;">
    </td>
  </tr>

  <!-- ===== WHAT THE FOLD IS ===== -->
  ${wavesSection(
    IMG.topicsWaves,
    `${eyebrow('WHAT THE FOLD IS', '32px 24px 0 24px')}
  <tr>
    <td align="center" style="padding:24px 24px 0 24px;${text(36, 40, 900)}letter-spacing:-1px;">A private, moderated community.</td>
  </tr>
  <tr>
    <td style="padding:20px 36px 0 36px;${text(17, 26)}">
      The Fold is a private, moderated community for people who take Israel and Jewish life as seriously as we do. It&rsquo;s your chance to weigh in on some of the most difficult questions Jews around the world are grappling with right now.
    </td>
  </tr>
  <tr>
    <td style="padding:24px 18px 0 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;border-collapse:collapse;">${chipRows}
        <tr>
          <td colspan="2" align="center" style="padding:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              <tr>
                <td width="25%" style="width:25%;font-size:0;line-height:0;">&nbsp;</td>${topicChip(TOPICS[6])}
                <td width="25%" style="width:25%;font-size:0;line-height:0;">&nbsp;</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:24px 36px 0 36px;${text(17, 26)}">
      Weigh in, debate, disagree, share a recipe, and learn from people who take it as seriously as you do. You&rsquo;ll find voices from across the Ark Media network in there too, from <em>Call me Back</em> to <em>Chosen People Problems</em>.
    </td>
  </tr>
  ${ruledLabel('Real debate stays.', `${text(26, 32, 900)}letter-spacing:-0.5px;`, '36px 24px 0 24px')}
  <tr>
    <td align="center" style="padding:12px 40px 0 40px;${text(15, 23)}">
      We moderate to keep out bad faith, trolling, harassment, and antisemitism &mdash; not to keep out disagreement.
    </td>
  </tr>`,
  )}

  <!-- ===== THE WELCOME OFFER ===== -->
  ${wavesSection(
    IMG.offerWaves,
    `${eyebrow('EXCLUSIVE FOR ARK+ MEMBERS', '8px 24px 0 24px')}
  <tr>
    <td align="center" style="padding:24px 24px 0 24px;${text(36, 40, 900)}letter-spacing:-1px;">You&rsquo;re already <span style="color:${ACCENT};">halfway there.</span></td>
  </tr>
  <tr>
    <td align="center" style="padding:14px 32px 0 32px;${text(17, 26)}">
      Add <strong>The Fold</strong> to your <strong>Ark+</strong> membership at a special welcome price.
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:24px 24px 0 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td valign="middle" style="padding-right:16px;${text(34, 36, 900)}letter-spacing:-1px;">Ark<span style="color:#3EB5F9;">+</span></td>
          <td valign="middle" style="border-left:1px solid ${NAVY};padding-left:16px;">
            <img src="${IMG.foldLogo}" alt="The Fold" width="150" style="display:block;width:150px;height:auto;border:0;">
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:12px 24px 0 24px;${text(15, 22)}">One membership. More ways to be part of Ark Media.</td>
  </tr>
  <tr>
    <td style="padding:20px 24px 0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;border-collapse:collapse;">
        <tr>
          <td width="50%" valign="top" style="width:50%;padding-right:6px;">${priceCard(
            'FOR MONTHLY MEMBERS',
            `${m.offer}/month`,
            `for your first ${p.discountedMonths} months`,
            `Then ${m.list}/month.`,
          )}
          </td>
          <td width="50%" valign="top" style="width:50%;padding-left:6px;">${priceCard(
            'FOR ANNUAL MEMBERS',
            `${y.offer}/year`,
            'for your first year',
            `Then ${y.list}/year.`,
          )}
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:14px 24px 0 24px;${text(10, 16)}letter-spacing:1.5px;">
      OFFER ENDS ${esc(WELCOME_OFFER_CLOSES_LABEL.toUpperCase())}&nbsp;&nbsp;|&nbsp;&nbsp;YOUR CURRENT BILLING CADENCE STAYS THE SAME.
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:22px 24px 0 24px;">${button(p.offerUrl, 'UPGRADE MY MEMBERSHIP', 10, 440)}
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:12px 32px 0 32px;${text(13, 20)}color:${BRAND_FG_MUTED};">
      You&rsquo;ll see exactly what&rsquo;s due today before anything is charged. Nothing changes unless you confirm.
    </td>
  </tr>`,
  )}

  <!-- ===== OPEN HOUSE ===== -->
  ${ruledLabel('JOIN US FOR A LIVE OPEN HOUSE', `${text(11, 16)}letter-spacing:2px;`, '8px 24px 0 24px')}
  <tr>
    <td align="center" style="padding:24px 24px 0 24px;${text(36, 40, 900)}letter-spacing:-1px;">See The Fold <span style="color:${ACCENT};">in action.</span></td>
  </tr>
  <tr>
    <td align="center" style="padding:14px 48px 0 48px;${text(16, 24)}">
      Join a live walkthrough to see the app, meet the team, and get a look at the conversations happening inside The Fold.
    </td>
  </tr>
  <tr>
    <td style="padding:28px 24px 0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>${openHouseColumn(IMG.ohCalendar, 'Live session', 'See the app in real time.')}${openHouseColumn(
          IMG.ohTeam,
          'Meet the team',
          'Get your questions answered.',
          `border-left:1px solid ${ACCENT};border-right:1px solid ${ACCENT};`,
        )}${openHouseColumn(IMG.ohChat, 'Learn more', 'See what makes The Fold different.')}
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:30px 20px 0 20px;">${button(p.openHouseUrl, 'REGISTER FOR AN OPEN HOUSE', 10, 440)}
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:14px 24px 36px 24px;${text(14, 20)}">
      <em>Choose the session that works best for you.</em>
    </td>
  </tr>
  <tr>
    <td style="padding:0 24px 40px 24px;">
      <p style="margin:0;padding-top:20px;border-top:1px solid #DDDEE4;${text(12, 19)}color:${BRAND_FG_MUTED};">${MANAGE_FOOTER}</p>
    </td>
  </tr>
</table>
</td>
</tr>
</table>
  </body>
</html>`

  return { subject: 'Keep the conversation going: your welcome offer for the Fold', html }
}
