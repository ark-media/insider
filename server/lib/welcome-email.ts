// Renders the welcome emails new members receive — gift recipients and regular
// subscribers. Pure (no I/O) so they're trivially testable; the activator hands
// the result to sendEmail().
//
// Each email is the single touchpoint for a new member: it carries the
// set-password link (an Auth0 password-change ticket, for brand-new accounts)
// and points at /welcome for feed + community setup. It replaces both the old
// SC welcome email and Auth0's own password-reset email.

import type { GiftTerm } from './activation.js'
import { greetingFirstName, splitFullName } from '../../shared/profile-name.js'

const GIFT_LABEL: Record<GiftTerm, string> = {
  '6mo': '6 months',
  '1yr': '1 year',
}

// ---------------------------------------------------------------------------
// Shared brand shell
// ---------------------------------------------------------------------------

const NAVY_900 = '#070b22'
const NAVY_800 = '#101736'
const CYAN = '#3eb5f9'
// Exported for other emails (e.g. the feed-setup reminder) that reuse the
// shell and need the brand cyan for inline links.
export const BRAND_CYAN = CYAN
const RULE = 'rgba(255,255,255,0.12)'
const FG = 'rgba(255,255,255,0.85)'
const FG_MUTED = 'rgba(255,255,255,0.62)'

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

type ShellParams = {
  preheader: string // hidden preview text; caller pre-escapes
  eyebrow: string
  headlineHtml: string // caller pre-escapes any user content
  greetingHtml: string
  bodyHtml: string
  messageBlockHtml?: string
  ctaHref: string
  ctaLabel: string
  ctaFollowupHtml: string
  footerHtml: string
}

export function renderShell(p: ShellParams): string {
  const messageBlock = p.messageBlockHtml ?? ''
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${NAVY_900};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${p.preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NAVY_900};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${NAVY_800};border:1px solid ${RULE};border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 8px;">
                <p style="margin:0;font:800 20px ${FONT};color:#ffffff;">Ark<span style="color:${CYAN};">+</span></p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 40px 0;">
                <p style="margin:0 0 8px;font:600 11px ${FONT};letter-spacing:0.18em;text-transform:uppercase;color:${CYAN};">${p.eyebrow}</p>
                <h1 style="margin:0 0 20px;font:700 26px/1.2 ${FONT};color:#ffffff;">${p.headlineHtml}</h1>
                <p style="margin:0 0 20px;font:400 15px/1.65 ${FONT};color:${FG};">${p.greetingHtml}</p>
                <p style="margin:0 0 28px;font:400 15px/1.65 ${FONT};color:${FG};">${p.bodyHtml}</p>
              </td>
            </tr>${messageBlock}
            <tr>
              <td style="padding:0 40px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:6px;background:${CYAN};">
                      <a href="${p.ctaHref}" style="display:inline-block;padding:14px 32px;font:700 13px ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:${NAVY_900};text-decoration:none;">${p.ctaLabel} &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 40px 36px;">
                <p style="margin:0;font:400 13px/1.6 ${FONT};color:${FG_MUTED};">${p.ctaFollowupHtml}</p>
              </td>
            </tr>
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

// The private-feed benefits every Ark+ (feed) tier gets. Bundle/gift append the
// community on top; a feed-only Ark+ membership stops here.
const FEED_INCLUDED =
  'extended interviews, ad-free episodes, members-only Q&amp;As, and the full archive — delivered as a private feed in the podcast app you already use'
const WHATS_INCLUDED = `${FEED_INCLUDED}, plus the Ark+ community`

// The greeting name, or undefined so the caller's "Hi there," stands. Routed
// through the shared helper rather than a bare split so a value that is really
// an email address — the gift form's recipient_name is free text a giver types —
// can't end up rendered as "Hi someone@example.com,".
function firstName(name?: string): string | undefined {
  const { first, last } = splitFullName(name)
  return greetingFirstName(first, undefined, last)
}

// Both emails share the same CTA logic: a brand-new account gets a
// set-password link (the Auth0 ticket); an existing account is pointed at
// sign-in. welcomeUrl is always referenced as the follow-up step.
// includesCommunity adds "join the community" to the setup step — true for
// bundle/gift (which carry community), false for a feed-only Ark+ membership.
function ctaFor(
  welcomeUrl: string,
  passwordSetupUrl?: string,
  includesCommunity = true,
) {
  const isNewAccount = Boolean(passwordSetupUrl)
  const newSetup = includesCommunity
    ? 'set up your private podcast feed and join the community'
    : 'set up your private podcast feed'
  const returningSetup = includesCommunity
    ? 'set up your feed and enter the community'
    : 'set up your feed and start listening'
  return {
    ctaHref: isNewAccount ? passwordSetupUrl! : welcomeUrl,
    ctaLabel: isNewAccount ? 'Set your password' : 'Start listening',
    ctaFollowupHtml: isNewAccount
      ? `Once you've set a password, you'll ${newSetup} at <a href="${welcomeUrl}" style="color:${CYAN};">your welcome page</a>.`
      : `You already have an Ark+ login — sign in to ${returningSetup} at <a href="${welcomeUrl}" style="color:${CYAN};">your welcome page</a>.`,
  }
}

// ---------------------------------------------------------------------------
// Gift recipient
// ---------------------------------------------------------------------------

export type GiftWelcomeEmailParams = {
  recipientName?: string
  giverName?: string
  term: GiftTerm
  message?: string
  welcomeUrl: string
  // Present only for brand-new accounts: an Auth0 password-change ticket URL.
  passwordSetupUrl?: string
}

export function renderGiftWelcomeEmail(p: GiftWelcomeEmailParams): {
  subject: string
  html: string
} {
  const termLabel = GIFT_LABEL[p.term]
  const giver = p.giverName?.trim()
  const first = firstName(p.recipientName)

  const subject = giver ? `${giver} sent you Ark+` : `You've been gifted Ark+`
  const headlineHtml = giver
    ? `${esc(giver)} gifted you ${termLabel} of Ark+.`
    : `You've been gifted ${termLabel} of Ark+.`

  const messageBlockHtml = p.message?.trim()
    ? `
            <tr>
              <td style="padding:0 0 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${CYAN};background:${NAVY_900};border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 6px;font:600 11px ${FONT};letter-spacing:0.16em;text-transform:uppercase;color:${CYAN};">A note from ${giver ? esc(giver) : 'the sender'}</p>
                      <p style="margin:0;font:italic 15px/1.6 ${FONT};color:${FG};">${esc(p.message.trim())}</p>
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
    bodyHtml: `Your membership is active now. It includes ${WHATS_INCLUDED}.`,
    messageBlockHtml,
    footerHtml: `Gifts are one-time — your access runs for ${termLabel} and won't auto-renew. Need help? Just reply to this email.`,
    ...ctaFor(p.welcomeUrl, p.passwordSetupUrl),
  })

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Regular subscriber
// ---------------------------------------------------------------------------

export type SubscriberWelcomeEmailParams = {
  name?: string
  welcomeUrl: string
  // Present only for brand-new accounts: an Auth0 password-change ticket URL.
  passwordSetupUrl?: string
  // Which feed tier this is. 'bundle' also carries the Circle community, so its
  // copy adds the community on top of the feed; 'ark-plus' is feed-only.
  tier: 'ark-plus' | 'bundle'
}

export function renderSubscriberWelcomeEmail(p: SubscriberWelcomeEmailParams): {
  subject: string
  html: string
} {
  const first = firstName(p.name)
  const includesCommunity = p.tier === 'bundle'
  const html = renderShell({
    preheader: includesCommunity
      ? 'Your Ark+ bundle membership is active.'
      : 'Your Ark+ membership is active.',
    eyebrow: "You're in",
    headlineHtml: includesCommunity ? 'Welcome to Ark+ Bundle.' : 'Welcome to Ark+.',
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml: `Your membership is active. It includes ${
      includesCommunity ? WHATS_INCLUDED : FEED_INCLUDED
    }.`,
    footerHtml:
      'Manage your membership anytime from your account. Need help? Just reply to this email.',
    ...ctaFor(p.welcomeUrl, p.passwordSetupUrl, includesCommunity),
  })
  return {
    subject: includesCommunity ? 'Welcome to Ark+ Bundle' : 'Welcome to Ark+',
    html,
  }
}

// ---------------------------------------------------------------------------
// Gift recipient — redemption link (grants nothing until claimed)
// ---------------------------------------------------------------------------

export type GiftRedemptionEmailParams = {
  recipientName?: string
  giverName?: string
  term: GiftTerm
  message?: string
  // The single magic link (/redeem?mt=…). One click logs the recipient in,
  // redeems the gift, and drops them into the welcome flow — no separate
  // sign-in or set-password step, and no Auth0 email.
  claimUrl: string
}

// A gift now grants nothing until the recipient redeems it (§3): this email
// carries the claim link rather than announcing an already-active membership.
// The term clock starts at redemption, so the copy avoids promising a start date.
export function renderGiftRedemptionEmail(p: GiftRedemptionEmailParams): {
  subject: string
  html: string
} {
  const termLabel = GIFT_LABEL[p.term]
  const giver = p.giverName?.trim()
  const first = firstName(p.recipientName)

  const subject = giver ? `${giver} sent you Ark+` : `You've been gifted Ark+`
  const headlineHtml = giver
    ? `${esc(giver)} gifted you ${termLabel} of Ark+.`
    : `You've been gifted ${termLabel} of Ark+.`

  const messageBlockHtml = p.message?.trim()
    ? `
            <tr>
              <td style="padding:0 0 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${CYAN};background:${NAVY_900};border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 6px;font:600 11px ${FONT};letter-spacing:0.16em;text-transform:uppercase;color:${CYAN};">A note from ${giver ? esc(giver) : 'the sender'}</p>
                      <p style="margin:0;font:italic 15px/1.6 ${FONT};color:${FG};">${esc(p.message.trim())}</p>
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
    bodyHtml: `Claim your gift to start your membership. It includes ${WHATS_INCLUDED}.`,
    messageBlockHtml,
    footerHtml: `Gifts are one-time — once claimed, your access runs for ${termLabel} and won't auto-renew. Redeem whenever you like; there's no deadline. Need help? Just reply to this email.`,
    ctaHref: p.claimUrl,
    ctaLabel: 'Start your membership',
    ctaFollowupHtml: `You'll be signed in automatically — no password needed. You can set one anytime from your welcome page.`,
  })

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Circle-only member (community access, no private feed)
// ---------------------------------------------------------------------------

export type CircleWelcomeEmailParams = {
  name?: string
  welcomeUrl: string
  // Present only for brand-new accounts: an Auth0 password-change ticket URL.
  passwordSetupUrl?: string
}

// A Circle-only membership grants the community, not the private podcast feed —
// so this copy is community-first and drops the feed-setup language. The CTA
// still routes brand-new accounts through set-password before the community.
export function renderCircleWelcomeEmail(p: CircleWelcomeEmailParams): {
  subject: string
  html: string
} {
  const first = firstName(p.name)
  const isNewAccount = Boolean(p.passwordSetupUrl)
  const html = renderShell({
    preheader: 'Your Ark community membership is active.',
    eyebrow: "You're in",
    headlineHtml: 'Welcome to the Ark community.',
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml:
      'Your community membership is active — join the conversation, member Q&amp;As, and events in the Ark community on Circle.',
    footerHtml:
      'Manage your membership anytime from your account. Need help? Just reply to this email.',
    ctaHref: isNewAccount ? p.passwordSetupUrl! : p.welcomeUrl,
    ctaLabel: isNewAccount ? 'Set your password' : 'Enter the community',
    ctaFollowupHtml: isNewAccount
      ? `Once you've set a password, you'll enter the community from <a href="${p.welcomeUrl}" style="color:${BRAND_CYAN};">your welcome page</a>.`
      : `You already have an Ark login — sign in to enter the community from <a href="${p.welcomeUrl}" style="color:${BRAND_CYAN};">your welcome page</a>.`,
  })
  return { subject: 'Welcome to the Ark community', html }
}
