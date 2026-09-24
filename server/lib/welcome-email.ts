// Renders the transactional lifecycle emails a member receives — the three
// purchase-confirmation welcomes (Ark+, the Fold, Bundle), the upgrade notice,
// and the gift claim link. Pure (no I/O) so they're trivially testable; the
// activator hands the result to sendEmail().
//
// The copy is the "Lifecycle Emails & Member Communications" doc. Two of its
// placeholders are resolved here rather than left in the markup:
//   [SUPPORT EMAIL PLACEHOLDER] → contactEmails.support, the desk the team staffs.
//   VISUAL BENEFITS LIST        → the text half (show + one-liner) from
//                                 src/data/shows.ts. See networkShowBullets().
//
// Both kinds of account get the doc's own CTA, which `activation.ts` wraps in
// an auto-login link — the click lands a new member signed in. `isNewAccount`
// picks the sentence underneath it: the two cases still need different
// reassurance.

import type { GiftTerm } from './activation.js'
import { greetingFirstName, splitFullName } from '../../shared/profile-name.js'
import { perPeriod, renewsLine, SETTLED_TODAY } from '../../shared/billing-copy.js'
import { circleUrls, contactEmails } from '../../src/config/urls.js'
import { shows } from '../../src/data/shows.js'

const GIFT_LABEL: Record<GiftTerm, string> = {
  '6mo': '6 months',
  '1yr': '1 year',
}

// ---------------------------------------------------------------------------
// Shared brand shell
// ---------------------------------------------------------------------------

// The site can flip between themes; an email cannot, so the shell is pinned to
// the light palette — these are the [data-theme="light"] tokens from
// src/index.css, flattened to solid hex because Outlook drops rgba() colours.
const PAPER = '#eef3fc' // --color-navy-900 (light): the page canvas
const SURFACE = '#ffffff' // --color-navy-800 (light): the card
const INK = '#0b153c' // --color-navy: wordmark and headings
const CYAN = '#0a6fad' // --color-cyan (light): brand #3eb5f9 fails AA on white
// Exported for other emails (e.g. the feed-setup reminder) that reuse the
// shell and need the brand cyan for inline links.
export const BRAND_CYAN = CYAN
// Same, for the footer's small-print links.
export const BRAND_FG_MUTED = '#686e86'
const RULE = '#dddee4' // --color-rule, over the card
const FG = '#373f5f' // --color-fg (10.3:1 on the card)
const FG_MUTED = BRAND_FG_MUTED // --color-fg-muted (5.0:1 on the card)

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

// Minimal HTML escaping for user-supplied values interpolated into the body
// (names, personal messages). Keeps a stray "<" or "&" from breaking markup.
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// A headed block below the CTA — the copy doc's "What you have access to",
// "What you'll find inside", "Getting started". Rendered in this order:
// heading, intro, bullets, paragraphs. That covers both shapes the doc uses
// (a lead-in then a list, or just prose) without callers hand-rolling markup.
type EmailSection = {
  heading?: string
  intro?: string
  bullets?: string[]
  paragraphs?: string[]
}

type ShellParams = {
  preheader: string // hidden preview text; caller pre-escapes
  eyebrow: string
  headlineHtml: string // caller pre-escapes any user content
  greetingHtml: string
  bodyHtml: string
  // An optional second body paragraph, for an email that carries two distinct
  // things to say (e.g. what you gained, then what it costs). Rendered with the
  // same styling as bodyHtml so callers never hand-roll the markup.
  bodySecondHtml?: string
  messageBlockHtml?: string
  ctaHref: string
  ctaLabel: string
  ctaFollowupHtml: string
  // Headed blocks between the CTA follow-up and the sign-off.
  sections?: EmailSection[]
  // The doc closes every lifecycle email with a thank-you and "The Ark Media
  // Team". Kept apart from footerHtml, which is the small-print row.
  signoffHtml?: string
  footerHtml: string
}

function renderSection(s: EmailSection): string {
  const heading = s.heading
    ? `<p style="margin:0 0 12px;font:700 15px/1.5 ${FONT};color:${INK};">${s.heading}</p>`
    : ''
  const intro = s.intro
    ? `<p style="margin:0 0 12px;font:400 15px/1.65 ${FONT};color:${FG};">${s.intro}</p>`
    : ''
  const bullets = s.bullets?.length
    ? `<ul style="margin:0 0 12px;padding:0 0 0 20px;font:400 15px/1.65 ${FONT};color:${FG};">${s.bullets
        .map((b) => `<li style="margin:0 0 8px;">${b}</li>`)
        .join('')}</ul>`
    : ''
  const paragraphs = (s.paragraphs ?? [])
    .map(
      (p) =>
        `<p style="margin:0 0 12px;font:400 15px/1.65 ${FONT};color:${FG};">${p}</p>`,
    )
    .join('')
  return `
            <tr>
              <td style="padding:4px 40px 12px;">${heading}${intro}${bullets}${paragraphs}</td>
            </tr>`
}

export function renderShell(p: ShellParams): string {
  const messageBlock = p.messageBlockHtml ?? ''
  const bodySecond = p.bodySecondHtml
    ? `\n                <p style="margin:0 0 28px;font:400 15px/1.65 ${FONT};color:${FG};">${p.bodySecondHtml}</p>`
    : ''
  const sections = (p.sections ?? []).map(renderSection).join('')
  const signoff = p.signoffHtml
    ? `
            <tr>
              <td style="padding:4px 40px 20px;">
                <p style="margin:0;font:400 15px/1.65 ${FONT};color:${FG};">${p.signoffHtml}</p>
              </td>
            </tr>`
    : ''
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <style>
      :root { color-scheme: light; supported-color-schemes: light; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${PAPER};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${p.preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${SURFACE};border:1px solid ${RULE};border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 8px;">
                <p style="margin:0;font:800 20px ${FONT};color:${INK};">Ark<span style="color:${CYAN};">+</span></p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 40px 0;">
                <p style="margin:0 0 8px;font:600 11px ${FONT};letter-spacing:0.18em;text-transform:uppercase;color:${CYAN};">${p.eyebrow}</p>
                <h1 style="margin:0 0 20px;font:700 26px/1.2 ${FONT};color:${INK};">${p.headlineHtml}</h1>
                <p style="margin:0 0 20px;font:400 15px/1.65 ${FONT};color:${FG};">${p.greetingHtml}</p>
                <p style="margin:0 0 28px;font:400 15px/1.65 ${FONT};color:${FG};">${p.bodyHtml}</p>${bodySecond}
              </td>
            </tr>${messageBlock}
            <tr>
              <td style="padding:0 40px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:6px;background:${CYAN};">
                      <a href="${p.ctaHref}" style="display:inline-block;padding:14px 32px;font:700 13px ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:${SURFACE};text-decoration:none;">${p.ctaLabel} &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 40px 20px;">
                <p style="margin:0;font:400 13px/1.6 ${FONT};color:${FG_MUTED};">${p.ctaFollowupHtml}</p>
              </td>
            </tr>${sections}${signoff}
            <tr>
              <td style="padding:20px 40px 32px;border-top:1px solid ${RULE};">
                <p style="margin:0;font:400 12px/1.6 ${FONT};color:${FG_MUTED};">${p.footerHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

// ---------------------------------------------------------------------------
// Shared copy blocks (the doc's placeholders, resolved)
// ---------------------------------------------------------------------------

export function link(href: string, label: string): string {
  return `<a href="${href}" style="color:${CYAN};">${label}</a>`
}

// [SUPPORT EMAIL PLACEHOLDER]. support@arkmedia.org is deliberately not on the
// ARK_DOMAIN — see contactEmails.support.
export const SUPPORT_EMAIL = contactEmails.support

// Every lifecycle email in the doc ends its instructions with this sentence.
// `lead` varies ("along the way" / "getting set up" / "right away"), the rest
// does not, so it lives in one place.
export function supportLine(
  lead = 'If you run into any trouble along the way',
): string {
  return `${lead}, reach out to us at ${link(
    `mailto:${SUPPORT_EMAIL}`,
    SUPPORT_EMAIL,
  )} and we'll help you get sorted.`
}

// The doc's "VISUAL BENEFITS LIST, PLACEHOLDER — key art and a one-line
// description for each show now included."
//
// This renders the text half only. Key art is still a design placeholder in the
// doc, and an <img> would be the wrong way to land it anyway: image blocking is
// the default in most mail clients, so the list would read as a row of gaps for
// most members. When the art exists it belongs here, with the show name as the
// alt text so a blocked image still names the show.
//
// Driven off src/data/shows.ts rather than a copy of the list, so a show added
// to the network reaches the welcome emails without a second edit. `paid` is
// excluded: that is the members-only show delivered through the private feed,
// not one of the network shows Ark+ makes ad-free and early.
export function networkShowBullets(): string[] {
  return shows
    .filter((s) => !s.paid)
    .map((s) => `<strong>${esc(s.title)}</strong> — ${esc(s.tagline)}`)
}

export const ARK_PLUS_EXTRAS =
  'Plus ad-free listening, early access, and our subscriber-exclusive newsletter.'

// The private-feed benefits every Ark+ (feed) tier gets, as one sentence — used
// where a full list would crowd the page (the upgrade email's Ark+ direction).
// Exported so the tests can assert WHICH blurb reaches which tier without
// pinning the copy; this wording is edited on its own schedule.
export const FEED_INCLUDED =
  'Exclusive content, Early Access to new episodes, and ad-free listening'

function arkPlusAccessSection(heading = 'What you have access to'): EmailSection {
  return {
    heading,
    bullets: networkShowBullets(),
    paragraphs: [ARK_PLUS_EXTRAS],
  }
}

// The doc's "What you'll find inside" block, shared by the Fold welcome and the
// upgrade email — both drop a member into the same place and say the same thing
// about it.
const FOLD_INSIDE_PARAGRAPHS = [
  "Some days that means debating the hardest questions facing Jewish life right now. Other days it's a good recipe or a joke only a few people will get. You'll find voices from across the Ark Media network in there too.",
  "If you have questions once you're in, or just want a hand finding your footing, look for Deborah Pardes. She's our community manager, and she's there to help.",
]

function foldInsideSection(): EmailSection {
  return { heading: "What you'll find inside", paragraphs: FOLD_INSIDE_PARAGRAPHS }
}

// "download The Fold app from the App Store or Google Play and sign in with the
// same account you used at arkmedia.org" — the doc's one setup step for the
// Fold, as links rather than prose. Plain text links, not the store badge
// lockups: SVG doesn't render in most mail clients, and image blocking would
// leave the row empty in the rest.
function foldAppLinks(lead = 'Download'): string {
  return (
    `${lead} The Fold app for ${link(circleUrls.appStoreIos, 'iPhone')} or ` +
    `${link(circleUrls.appStoreAndroid, 'Android')}, or ` +
    `${link(circleUrls.webApp, 'open it in your browser')}, and sign in with the ` +
    `same account you used at arkmedia.org.`
  )
}

// The doc's Ark+ setup step. `setupUrl` is the app's /setup page — the copy
// names it as arkmedia.org/setup, which is what that page is in production.
function arkPlusSetupStep(setupUrl: string, lead: string): string {
  return (
    `${lead} You may have done this during checkout, but depending on how you ` +
    `listen, you'll need to add a private RSS feed for each show or connect your ` +
    `subscription to Spotify. Either way, follow the step by step instructions at ` +
    `${link(setupUrl, 'arkmedia.org/setup')}.`
  )
}

// The sentence that precedes the support line in every welcome follow-up.
//
// Both cases now share a CTA, so this is the only place they differ. A new
// account is told the link signs them in, which is what stops someone who has
// just been told they have an account from hunting for a credential. An existing
// account gets nothing here: a "sign in with the login you already have" line
// read as confusing, so it was dropped.
//
// The sentence never names a password, and no member-facing copy anywhere does.
// Sign-in is an emailed code or Google; a member who never had a password does
// not need to hear that one is absent, and raising it only invites the hunt
// this sentence exists to prevent.
function ctaPrelude(isNewAccount: boolean, welcomeUrl: string): string {
  return isNewAccount
    ? `That link signs you in automatically. ${link(welcomeUrl, 'Your welcome page')} walks you through the rest. `
    : ''
}

export const ARK_MEDIA_TEAM = 'The Ark Media Team'
export const MANAGE_FOOTER =
  'Manage your membership anytime from your account. Need help? Just reply to this email.'

// The greeting name, or undefined so the caller's "Hi there," stands. Routed
// through the shared helper rather than a bare split so a value that is really
// an email address — the gift form's recipient_name is free text a giver types —
// can't end up rendered as "Hi someone@example.com,".
//
// `email` is the recipient's address, and it is what makes the check work at
// all: without it `hasRealName` has nothing to compare against and accepts any
// non-empty string, so a local-part value already on the record
// ("hannah.waxman8") renders as a greeting. Every caller has it in hand.
function firstName(name?: string, email?: string): string | undefined {
  const { first, last } = splitFullName(name)
  return greetingFirstName(first, email, last)
}

// ---------------------------------------------------------------------------
// Purchase confirmation / Welcome / Getting started — Ark+ and Bundle
// ---------------------------------------------------------------------------

export type SubscriberWelcomeEmailParams = {
  name?: string
  // The member's address — required for the name check, see firstName().
  email?: string
  welcomeUrl: string
  // The feed-setup page (/setup). The doc points every Ark+ instruction at
  // arkmedia.org/setup; the welcome page covers the same ground for someone
  // who has just been provisioned, and links on to this.
  setupUrl: string
  // Whether this membership just created the Auth0 account. Picks the sentence
  // under the CTA (ctaPrelude), nothing else.
  isNewAccount?: boolean
  // Which feed tier this is. 'bundle' also carries the Fold (Circle), so its
  // copy adds the Fold on top of the feed; 'ark-plus' is feed-only.
  tier: 'ark-plus' | 'bundle'
}

export function renderSubscriberWelcomeEmail(p: SubscriberWelcomeEmailParams): {
  subject: string
  html: string
} {
  const first = firstName(p.name, p.email)
  const includesCommunity = p.tier === 'bundle'
  const isNewAccount = Boolean(p.isNewAccount)

  // One CTA for both: setup is the first thing either kind of account needs,
  // and the caller's auto-login wrapper is what makes it reachable for an
  // account that has never signed in.
  const ctaHref = p.setupUrl
  const ctaLabel = 'Finish setup'
  const prelude = ctaPrelude(isNewAccount, p.welcomeUrl)

  const arkPlusStep = arkPlusSetupStep(
    p.setupUrl,
    includesCommunity
      ? 'For Ark+:'
      : "There's one step left before you can access all of your benefits.",
  )

  if (!includesCommunity) {
    return {
      subject: 'Welcome to Ark+, one quick step left',
      html: renderShell({
        preheader: 'How to unlock all your new benefits.',
        eyebrow: "You're in",
        headlineHtml: 'Welcome to Ark+.',
        greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
        bodyHtml:
          "You're officially a member! Thank you for joining, and welcome to Ark+.",
        bodySecondHtml: arkPlusStep,
        ctaHref,
        ctaLabel,
        ctaFollowupHtml: `${prelude}${supportLine()}`,
        sections: [arkPlusAccessSection()],
        signoffHtml: `Thank you for supporting independent Jewish media.<br />${ARK_MEDIA_TEAM}`,
        footerHtml: MANAGE_FOOTER,
      }),
    }
  }

  return {
    subject: 'Welcome to Ark+ and The Fold',
    html: renderShell({
      preheader: "You're in on everything. Here's how to get started.",
      eyebrow: "You're in",
      headlineHtml: 'Welcome to Ark+ and the Fold.',
      greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
      bodyHtml:
        "You're officially a member of both. Thank you for joining, and welcome to everything Ark Media has to offer.",
      bodySecondHtml: 'There are two quick steps to unlock everything.',
      ctaHref,
      ctaLabel,
      ctaFollowupHtml: `${prelude}${supportLine()}`,
      sections: [
        {
          heading: 'Getting started',
          paragraphs: [arkPlusStep, `For the Fold: ${foldAppLinks()}`],
        },
        {
          ...arkPlusAccessSection(),
          paragraphs: [
            ARK_PLUS_EXTRAS,
            ...FOLD_INSIDE_PARAGRAPHS,
            "By joining both Ark+ and the Fold, you're now supporting everything we make at Ark Media, our shows and this community alike. That kind of support is what makes all of it possible, and it doesn't go unnoticed.",
          ],
        },
      ],
      signoffHtml: ARK_MEDIA_TEAM,
      footerHtml: MANAGE_FOOTER,
    }),
  }
}

// ---------------------------------------------------------------------------
// Gift recipient — redemption link (grants nothing until claimed)
// ---------------------------------------------------------------------------

export type GiftRedemptionEmailParams = {
  recipientName?: string
  // The recipient's address — required for the name check, see firstName().
  recipientEmail?: string
  giverName?: string
  term: GiftTerm
  message?: string
  // The single magic link (/redeem?mt=…). One click logs the recipient in,
  // redeems the gift, and drops them into the welcome flow — no separate
  // sign-in step, and no Auth0 email.
  claimUrl: string
}

// The giver's name as it may appear in the SUBJECT line.
//
// Everything else in this email goes through esc() into HTML, where the worst a
// hostile name can do is look odd. The subject is different on all three counts:
// it is a mail header (a newline in it is a header-injection attempt, whatever
// the transport does about it later), it is what the recipient judges the email
// by before opening it, and it is sent from OUR domain with our reputation
// behind it — while `giver_name` is free text typed by an unauthenticated buyer
// into a form that mails any address they choose. Left alone that is a relay for
// "Your account is locked, visit evil.example" under our From line.
//
// So the subject gets the name and nothing but: controls and line breaks out,
// whitespace collapsed, anything link-shaped removed (schemes, `www.`, and bare
// `domain.tld/…` — mail clients autolink all three), and a hard cap, cut on a
// code point rather than a UTF-16 unit so an emoji at the boundary isn't halved
// into a lone surrogate. A name with nothing left falls back to the no-name
// subject rather than sending "  sent you Ark+".
const SUBJECT_NAME_MAX = 60

function subjectName(raw: string | undefined): string {
  if (!raw) return ''
  const cleaned = raw
    .replace(/[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/gu, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/[a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, SUBJECT_NAME_MAX).join('').trim()
}

// The checkout route refuses a longer note, and Stripe metadata (which is how
// the note reaches the webhook) can't hold one either — this is the renderer
// not taking either of those on trust.
const GIFT_MESSAGE_MAX = 500

// A gift now grants nothing until the recipient redeems it (§3): this email
// carries the claim link rather than announcing an already-active membership.
// The term clock starts at redemption, so the copy avoids promising a start date.
//
// Not in the copy doc — gifting postdates it — so this keeps its own wording.
export function renderGiftRedemptionEmail(p: GiftRedemptionEmailParams): {
  subject: string
  html: string
} {
  const termLabel = GIFT_LABEL[p.term]
  const giver = p.giverName?.trim()
  const first = firstName(p.recipientName, p.recipientEmail)

  const giverInSubject = subjectName(giver)
  const subject = giverInSubject
    ? `${giverInSubject} sent you Ark+`
    : `You've been gifted Ark+`
  const headlineHtml = giver
    ? `${esc(giver)} gifted you ${termLabel} of Ark+.`
    : `You've been gifted ${termLabel} of Ark+.`

  const message = Array.from(p.message?.trim() ?? '')
    .slice(0, GIFT_MESSAGE_MAX)
    .join('')
  const messageBlockHtml = message
    ? `
            <tr>
              <td style="padding:0 0 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${CYAN};background:${PAPER};border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 6px;font:600 11px ${FONT};letter-spacing:0.16em;text-transform:uppercase;color:${CYAN};">A note from ${giver ? esc(giver) : 'the sender'}</p>
                      <p style="margin:0;font:italic 15px/1.6 ${FONT};color:${FG};">${esc(message)}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
    : undefined

  const html = renderShell({
    preheader: esc(headlineHtml),
    eyebrow: 'A gift for you',
    headlineHtml,
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml: `Claim your gift to start your membership. It includes ${FEED_INCLUDED}, plus the Fold.`,
    messageBlockHtml,
    footerHtml: `Gifts are one-time — once claimed, your access runs for ${termLabel} and won't auto-renew. Redeem whenever you like; there's no deadline. Need help? Just reply to this email.`,
    ctaHref: p.claimUrl,
    ctaLabel: 'Start your membership',
    ctaFollowupHtml: `You'll be signed in automatically. Next time, sign in with a one-time code we email you, or with Google.`,
  })

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Purchase confirmation / Welcome / Getting started — the Fold (no feed)
// ---------------------------------------------------------------------------

export type CircleWelcomeEmailParams = {
  name?: string
  // The member's address — required for the name check, see firstName().
  email?: string
  welcomeUrl: string
  // Whether this membership just created the Auth0 account. Picks the sentence
  // under the CTA (ctaPrelude), nothing else.
  isNewAccount?: boolean
}

// A Circle-only membership grants the Fold, not the private podcast feed —
// so this copy is Fold-first and drops the feed-setup language. Every account
// goes straight to the Fold; the caller's auto-login wrapper carries a
// brand-new one in without a credential.
export function renderCircleWelcomeEmail(p: CircleWelcomeEmailParams): {
  subject: string
  html: string
} {
  const first = firstName(p.name, p.email)
  const isNewAccount = Boolean(p.isNewAccount)
  // Only the new-account half of ctaPrelude is wanted here: the body above
  // already told an existing member to sign in with the account they have, and
  // saying it twice in four lines reads as a warning rather than reassurance.
  const prelude = isNewAccount ? ctaPrelude(true, p.welcomeUrl) : ''
  const html = renderShell({
    preheader: "Here's how to get started.",
    eyebrow: "You're in",
    headlineHtml: 'Welcome to the Fold.',
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml: "You're in! Thank you for joining the Fold.",
    bodySecondHtml: foldAppLinks("If you haven't already, download"),
    ctaHref: p.welcomeUrl,
    ctaLabel: 'Enter the Fold',
    ctaFollowupHtml: `${prelude}${supportLine('If you run into any trouble getting set up')}`,
    sections: [foldInsideSection()],
    signoffHtml: `Thank you for being part of this.<br />${ARK_MEDIA_TEAM}`,
    footerHtml: MANAGE_FOOTER,
  })
  return { subject: 'Welcome to The Fold', html }
}

// ---------------------------------------------------------------------------
// Upgrade confirmation — an existing member who added an axis
// (Ark+ → Bundle, or the Fold → Bundle)
// ---------------------------------------------------------------------------

export type AxisAddedEmailParams = {
  name?: string
  // The member's address — required for the name check, see firstName().
  email?: string
  // The axis they just gained. The other one they already had, so this decides
  // both the headline and which setup step the CTA points at.
  axis: 'ark-plus' | 'circle'
  welcomeUrl: string
  // The feed-setup page (/setup) — only used by the 'ark-plus' direction.
  setupUrl: string
  // The new price, pre-formatted in the currency the subscription actually
  // bills in (see formatMinorUnits) — e.g. "$25". Omitted when the amount can't
  // be read, and the sentence then says what the membership covers without
  // naming a figure rather than guessing at one.
  price?: string
  plan: 'monthly' | 'yearly'
  // The next billing date, pre-formatted by the caller (the caller owns the
  // timezone — see EMAIL_TIME_ZONE). Omitted when unreadable.
  renewsOn?: string
}

// The member already had one axis on a live subscription and just added the
// other, so their membership now covers both. This is NOT a welcome email:
// they have a login, they've been provisioned before, and `wasUnprovisioned` in
// activation.ts is exactly what keeps the welcome copy away from them.
//
// The copy doc covers the Ark+ → Bundle direction ("You've added The Fold to
// your membership"). The reverse — a Fold member adding Ark+ — has no entry
// there, so it keeps the wording this renderer already had.
//
// It doubles as the billing-change notice, which is why the price is here at
// all (the doc's version has no price line; dropping ours would leave the
// member with no notice of the new recurring amount until the next invoice).
// Two rules hold that half of the copy together:
//
//   1. State the new price as what the membership costs, full stop. The fear
//      it defuses — "is this on top of what I already pay?" — is better killed
//      by "that covers everything" than by arguing the negative.
//   2. Answer "what was I charged today, and when do I renew?" out loud. The
//      switch charges the new price less credit for the old plan's unused time
//      and restarts the cycle from today, so the renewal date has moved too.
//
// Both sentences come from shared/billing-copy.ts, which the account page's
// confirm panel reads too: this email is the follow-up to a promise made
// there, so the two cannot word the same facts differently. This renderer is
// told the new price, never the charge, so it says how today's bill was worked
// out and leaves the figure to Stripe's receipt.
export function renderAxisAddedEmail(p: AxisAddedEmailParams): {
  subject: string
  html: string
} {
  const first = firstName(p.name, p.email)
  const addedCircle = p.axis === 'circle'

  const coversEverything = 'the private feed and the Fold'
  const priceSentence = p.price
    ? `Your membership is now <strong>${esc(p.price)} ${perPeriod(p.plan)}</strong>, and that covers everything: ${coversEverything}.`
    : `Your membership now covers everything: ${coversEverything}.`
  // Same facts the confirm panel promised — see shared/billing-copy.ts.
  const billSentence = ` ${SETTLED_TODAY} ${renewsLine({
    plan: p.plan,
    renewsOn: p.renewsOn ? esc(p.renewsOn) : null,
  })}`

  if (addedCircle) {
    // The app links live in the email itself, not only behind the CTA. A new
    // Fold member meets these on /welcome; someone who upgrades from their
    // account page never passes through it, and getting the app is the one
    // step that actually puts them in the Fold.
    const followup =
      `Since you're already set up with Ark+, there's just one more step. ` +
      `${foldAppLinks()} Then ${link(circleUrls.profileSettings, 'set up your profile')} — ` +
      `a photo and a line about yourself — so people know who they're talking to. ` +
      `${supportLine('If you run into any trouble getting set up')}`

    return {
      subject: "You've added The Fold to your membership",
      html: renderShell({
        preheader: "Here's how to get started.",
        eyebrow: 'Added to your membership',
        headlineHtml: "You've added the Fold to your membership.",
        greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
        bodyHtml:
          "You're officially a member of the Fold too. Thank you for upgrading.",
        bodySecondHtml: `${priceSentence}${billSentence}`,
        ctaHref: p.welcomeUrl,
        ctaLabel: 'Enter the Fold',
        ctaFollowupHtml: followup,
        sections: [foldInsideSection()],
        signoffHtml: `Thank you for being part of all of this.<br />${ARK_MEDIA_TEAM}`,
        footerHtml: MANAGE_FOOTER,
      }),
    }
  }

  return {
    subject: 'Your Ark+ private feed is ready',
    html: renderShell({
      preheader: 'Your private feed is ready — your membership covers everything now.',
      eyebrow: 'Added to your membership',
      headlineHtml: 'Your private feed is ready.',
      greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
      bodyHtml: `You just added the private podcast feed — ${FEED_INCLUDED}.`,
      bodySecondHtml: `${priceSentence}${billSentence}`,
      ctaHref: p.setupUrl,
      ctaLabel: 'Set up your feed',
      ctaFollowupHtml:
        `Depending on how you listen, you'll add a private RSS feed for each show or ` +
        `connect to Spotify — the step by step instructions are at ` +
        `${link(p.setupUrl, 'arkmedia.org/setup')}. ${supportLine()}`,
      sections: [arkPlusAccessSection()],
      signoffHtml: `Thank you for supporting independent Jewish media.<br />${ARK_MEDIA_TEAM}`,
      footerHtml: MANAGE_FOOTER,
    }),
  }
}
