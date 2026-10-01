// Renders the transactional lifecycle emails a member receives — the Bundle
// and Fold welcomes (Ark+ alone is welcomed with the launch email,
// feed-move-email.ts), the upgrade notice, and the gift claim link. Pure (no I/O) so they're trivially testable; the
// activator hands the result to sendEmail().
//
// Layout and voice are the launch emails' (see email-layout.ts): a short
// headline with a cyan payoff, one thing to do, and nothing about how it works
// underneath. Every welcome's button is wrapped by `activation.ts` in an
// auto-login link, so a brand-new account lands signed in; `isNewAccount` only
// decides whether to say so.

import type { GiftTerm } from './activation.js'
import {
  accent,
  esc,
  greeting,
  link,
  MANAGE_FOOTER,
  renderShell,
  supportLine,
  type EmailItem,
  type EmailSection,
} from './email-layout.js'
import { greetingFirstName, splitFullName } from '../../shared/profile-name.js'
import { perPeriod, renewsLine, SETTLED_TODAY } from '../../shared/billing-copy.js'
import { circleUrls } from '../../src/config/urls.js'

const GIFT_LABEL: Record<GiftTerm, string> = {
  '6mo': '6 months',
  '1yr': '1 year',
}

// The private-feed benefits every Ark+ (feed) tier gets, as one phrase.
// Exported so the tests can assert WHICH blurb reaches which tier without
// pinning the copy.
export const FEED_INCLUDED =
  'early access, ad-free listening, and exclusive content across every show'

// "What you now get" — the launch email's network section.
function networkSection(): EmailSection {
  return {
    eyebrow: 'What you now get',
    headingHtml: `One membership.<br />The whole ${accent('network.')}`,
    introHtml:
      'Early access, ad-free listening, and exclusive content across every show in the network, plus our weekly subscriber-exclusive newsletter.',
    shows: true,
  }
}

// "What you'll find inside" the Fold, shared by the Fold welcome and the
// upgrade email — both drop a member into the same place.
function foldInsideSection(): EmailSection {
  return {
    eyebrow: 'Inside the Fold',
    headingHtml: `Real debate ${accent('stays.')}`,
    introHtml:
      'The hardest questions facing Jewish life, a good recipe, a joke only a few people will get. Voices from across the Ark Media network are in there too. Look for Deborah Pardes, our community manager, if you want a hand finding your footing.',
  }
}

// The Fold's setup steps. Plain text links, not store badges: SVG doesn't
// render in most mail clients.
function foldAppItem(): EmailItem {
  return {
    title: 'Get the app',
    bodyHtml:
      `Download The Fold for ${link(circleUrls.appStoreIos, 'iPhone')} or ` +
      `${link(circleUrls.appStoreAndroid, 'Android')}, or ` +
      `${link(circleUrls.webApp, 'open it in your browser')}. Sign in with the same account.`,
  }
}

function foldProfileItem(): EmailItem {
  return {
    title: 'Set up your profile',
    bodyHtml: `Add ${link(circleUrls.profileSettings, 'a photo and a line about yourself')} so people know who they&rsquo;re talking to.`,
  }
}

function feedItem(setupUrl: string): EmailItem {
  return {
    title: 'Set up your feed',
    bodyHtml: `Connect Spotify once, or add a private feed for each show in your podcast app, at ${link(setupUrl, 'arkmedia.org/setup')}.`,
  }
}

// Said only to a brand-new account, which is the one that might go hunting for
// a credential. Never names a password: sign-in is an emailed code or Google.
function signsYouIn(isNewAccount: boolean): string {
  return isNewAccount ? ' This button signs you in automatically.' : ''
}

const FEED_ACTION_BODY = 'It should take about 5 minutes.'

// The greeting name, or undefined so "Hi there," stands. Routed through the
// shared helper so a value that is really an email address (the gift form's
// recipient_name is free text) can't render as "Hi someone@example.com,".
function firstName(name?: string, email?: string): string | undefined {
  const { first, last } = splitFullName(name)
  return greetingFirstName(first, email, last)
}

// ---------------------------------------------------------------------------
// Welcome — Bundle (Ark+ alone gets the launch email, feed-move-email.ts)
// ---------------------------------------------------------------------------

export type BundleWelcomeEmailParams = {
  name?: string
  // The member's address — required for the name check, see firstName().
  email?: string
  // The feed-setup page (/setup), where the button lands.
  setupUrl: string
  // Whether this membership just created the account. Only decides whether the
  // email says the button signs them in.
  isNewAccount?: boolean
}

export function renderBundleWelcomeEmail(p: BundleWelcomeEmailParams): {
  subject: string
  html: string
} {
  return {
    subject: 'Welcome to Ark+ and The Fold',
    html: renderShell({
      preheader: 'Every show. The whole community. Two quick steps to get started.',
      headlineHtml: `Welcome to Ark+ and ${accent('the Fold.')}`,
      sublineHtml: 'Every show. The whole community. One membership.',
      greetingHtml: greeting(firstName(p.name, p.email)),
      bodyHtml: ['Thank you for joining. There are two quick steps to unlock everything.'],
      sections: [
        { eyebrow: 'Getting started', items: [feedItem(p.setupUrl), foldAppItem()] },
        networkSection(),
        foldInsideSection(),
      ],
      action: {
        eyebrow: 'What you need to do',
        headingHtml: `Start with your ${accent('private feed.')}`,
        bodyHtml: `${FEED_ACTION_BODY}${signsYouIn(Boolean(p.isNewAccount))}`,
        href: p.setupUrl,
        label: 'Set up my feed',
      },
      closingHtml: `You&rsquo;re now supporting everything we make at Ark Media, our shows and this community alike. Thank you. ${supportLine()}`,
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
  // What was gifted. The subject, headline and body all name it.
  tier: GiftTier
  message?: string
  // The single magic link (/redeem?mt=…). One click logs the recipient in,
  // redeems the gift, and drops them into the welcome flow.
  claimUrl: string
}

type GiftTier = 'ark-plus' | 'circle' | 'bundle'

// `name` after "gifted you 1 year of"; `includes` is the subline.
const GIFT_TIER_COPY: Record<GiftTier, { name: string; includes: string }> = {
  'ark-plus': { name: 'Ark+', includes: `That&rsquo;s ${FEED_INCLUDED} in the network.` },
  circle: {
    name: 'the Fold',
    includes: 'A private, moderated community for people who take Israel and Jewish life seriously.',
  },
  bundle: { name: 'Ark+ and the Fold', includes: `That&rsquo;s ${FEED_INCLUDED} in the network, plus the Fold.` },
}

// The giver's name as it may appear in the SUBJECT line.
//
// Everything else in this email goes through esc() into HTML, where the worst a
// hostile name can do is look odd. The subject is a mail header sent from OUR
// domain, while `giver_name` is free text typed by an unauthenticated buyer
// into a form that mails any address they choose. So the subject gets the name
// and nothing but: controls and line breaks out, whitespace collapsed, anything
// link-shaped removed (schemes, `www.`, and bare `domain.tld/…` — mail clients
// autolink all three), and a hard cap, cut on a code point so an emoji at the
// boundary isn't halved. A name with nothing left falls back to the no-name
// subject.
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

// The checkout route refuses a longer note, and Stripe metadata can't hold one
// either — this is the renderer not taking either of those on trust.
const GIFT_MESSAGE_MAX = 500

// A gift grants nothing until the recipient redeems it, and the term clock
// starts at redemption, so the copy never promises a start date.
export function renderGiftRedemptionEmail(p: GiftRedemptionEmailParams): {
  subject: string
  html: string
} {
  const termLabel = GIFT_LABEL[p.term]
  const giver = p.giverName?.trim()
  const gift = GIFT_TIER_COPY[p.tier]

  const giverInSubject = subjectName(giver)
  const subject = giverInSubject
    ? `${giverInSubject} sent you ${gift.name}`
    : `You've been gifted ${gift.name}`
  const lead = giver ? `${esc(giver)} gifted you` : 'You&rsquo;ve been gifted'
  const headlineHtml = `${lead} ${termLabel} of ${accent(`${gift.name}.`)}`

  const message = Array.from(p.message?.trim() ?? '')
    .slice(0, GIFT_MESSAGE_MAX)
    .join('')

  const html = renderShell({
    preheader: `${lead} ${termLabel} of ${gift.name}.`,
    kicker: 'A gift for you',
    headlineHtml,
    sublineHtml: gift.includes,
    greetingHtml: greeting(firstName(p.recipientName, p.recipientEmail)),
    sections: message
      ? [{ note: { label: `A note from ${giver ? esc(giver) : 'the sender'}`, bodyHtml: esc(message) } }]
      : [],
    action: {
      eyebrow: 'What you need to do',
      headingHtml: `Claim your ${accent('gift.')}`,
      bodyHtml:
        'One click signs you in and starts your membership. Next time, sign in with a code we email you, or with Google.',
      href: p.claimUrl,
      label: 'Start your membership',
    },
    footerHtml: `Gifts don&rsquo;t renew. Your ${termLabel} starts when you claim it, and there&rsquo;s no deadline to claim. Need help? Just reply to this email.`,
  })

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Welcome — the Fold (no feed)
// ---------------------------------------------------------------------------

export type CircleWelcomeEmailParams = {
  name?: string
  // The member's address — required for the name check, see firstName().
  email?: string
  welcomeUrl: string
  // Whether this membership just created the account. Only decides whether the
  // email says the button signs them in.
  isNewAccount?: boolean
}

// A Fold-only membership has no private feed, so there's no feed setup here.
export function renderCircleWelcomeEmail(p: CircleWelcomeEmailParams): {
  subject: string
  html: string
} {
  const html = renderShell({
    preheader: 'A private, moderated community. Here&rsquo;s how to get started.',
    headlineHtml: `Welcome to ${accent('the Fold.')}`,
    sublineHtml: 'A private, moderated community for people who take Israel and Jewish life seriously.',
    greetingHtml: greeting(firstName(p.name, p.email)),
    bodyHtml: ['Thank you for joining. Two quick steps and you&rsquo;re in the conversation.'],
    sections: [
      { eyebrow: 'Getting started', items: [foldAppItem(), foldProfileItem()] },
      foldInsideSection(),
    ],
    action: {
      headingHtml: `Keep the conversation ${accent('going.')}`,
      bodyHtml: signsYouIn(Boolean(p.isNewAccount)).trim() || undefined,
      href: p.welcomeUrl,
      label: 'Enter the Fold',
    },
    closingHtml: `Thank you for being part of this. ${supportLine()}`,
    footerHtml: MANAGE_FOOTER,
  })
  return { subject: 'Welcome to The Fold', html }
}

// ---------------------------------------------------------------------------
// Upgrade — an existing member who added the other half
// (Ark+ → Bundle, or the Fold → Bundle)
// ---------------------------------------------------------------------------

export type AxisAddedEmailParams = {
  name?: string
  // The member's address — required for the name check, see firstName().
  email?: string
  // What they just gained.
  axis: 'ark-plus' | 'circle'
  welcomeUrl: string
  // The feed-setup page (/setup) — only used by the 'ark-plus' direction.
  setupUrl: string
  // The new price, pre-formatted in the subscription's currency (e.g. "$25").
  // Omitted when unreadable; the copy then names no figure.
  price?: string
  plan: 'monthly' | 'yearly'
  // The next billing date, pre-formatted by the caller. Omitted when unreadable.
  renewsOn?: string
}

// Not a welcome: they already have an account. It doubles as the billing-change
// notice, so it states the new price as what the whole membership costs and
// answers "what was I charged, and when do I renew?" in the same words the
// confirm panel used (shared/billing-copy.ts).
export function renderAxisAddedEmail(p: AxisAddedEmailParams): {
  subject: string
  html: string
} {
  const greetingHtml = greeting(firstName(p.name, p.email))
  const priceSentence = p.price
    ? `Your membership is now <strong>${esc(p.price)} ${perPeriod(p.plan)}</strong>, and that covers everything: every show and the Fold.`
    : 'Your membership now covers everything: every show and the Fold.'
  const billSentence = `${SETTLED_TODAY} ${renewsLine({
    plan: p.plan,
    renewsOn: p.renewsOn ? esc(p.renewsOn) : null,
  })}`

  if (p.axis === 'circle') {
    return {
      subject: "You've added The Fold to your membership",
      html: renderShell({
        preheader: 'Ark+ and the Fold. One membership. Here&rsquo;s how to get in.',
        headlineHtml: `You&rsquo;ve added ${accent('the Fold.')}`,
        sublineHtml: 'Ark+ and the Fold. One membership.',
        greetingHtml,
        bodyHtml: [`Thank you for upgrading. ${priceSentence}`, billSentence],
        sections: [
          { eyebrow: 'Getting started', items: [foldAppItem(), foldProfileItem()] },
          foldInsideSection(),
        ],
        action: {
          headingHtml: `Keep the conversation ${accent('going.')}`,
          href: p.welcomeUrl,
          label: 'Enter the Fold',
        },
        closingHtml: `Thank you for being part of all of this. ${supportLine()}`,
        footerHtml: MANAGE_FOOTER,
      }),
    }
  }

  return {
    subject: 'Your Ark+ private feed is ready',
    html: renderShell({
      preheader: 'Every Ark Media show. More exclusive content. One quick step left.',
      headlineHtml: `Your private feed is ${accent('ready.')}`,
      sublineHtml: 'Ark+ and the Fold. One membership.',
      greetingHtml,
      bodyHtml: [`Thank you for upgrading. ${priceSentence}`, billSentence],
      sections: [networkSection()],
      action: {
        eyebrow: 'What you need to do',
        headingHtml: `Set up your ${accent('private feed.')}`,
        bodyHtml: `Connect Spotify once, or add a private feed for each show in your podcast app. ${FEED_ACTION_BODY}`,
        href: p.setupUrl,
        label: 'Set up my feed',
      },
      closingHtml: `Thank you for supporting independent Jewish media. ${supportLine()}`,
      footerHtml: MANAGE_FOOTER,
    }),
  }
}
