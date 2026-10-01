// The cancellation-confirmation emails, and their partial sibling: the debundle
// notice. Both say the same three things — what you're losing, what you keep,
// and the date the change lands — so they share a module and a shape.
//
// Pure (no I/O) so they're trivially testable; the routes hand the result to
// sendEmail().

import {
  accent,
  esc,
  greeting,
  link,
  MANAGE_FOOTER,
  renderShell,
  supportLine,
} from './email-layout.js'
import { perPeriod, type BillingPlan } from '../../shared/billing-copy.js'

// The tier being left. 'free' never reaches these renderers — there is nothing
// to cancel — so it is deliberately not in the union.
export type CancellableTier = 'ark-plus' | 'circle' | 'bundle'

// What a member sees their membership called, in the POSSESSIVE position —
// "your ___ membership". That is the only position these labels are used in,
// and it is why the Fold appears here without its article: "your The Fold
// membership" is not a sentence.
export const TIER_EMAIL_LABEL: Record<CancellableTier, string> = {
  'ark-plus': 'Ark+',
  circle: 'Fold',
  bundle: 'Ark+ and Fold',
}

// Why the thing they just left exists, one per tier — a Fold canceller is not
// owed a line about ad-free listening.
const WHY_WE_EXIST: Record<CancellableTier, string> = {
  'ark-plus':
    'Ark+ is what makes honest coverage of Israel and the Jewish world possible, funded by members instead of advertisers or algorithms. You can rejoin anytime at arkmedia.org.',
  circle:
    'The Fold is where this community talks to each other, without the noise everywhere else online. You can rejoin anytime at arkmedia.org.',
  bundle:
    'Ark+ keeps our coverage of Israel and the Jewish world independent, and the Fold gives this community a place to talk. You can rejoin either anytime at arkmedia.org.',
}

// What stops, and when. The date sits inside the sentence so "you still have
// access" and "until when" can't be read apart.
function whatYouKeep(tier: CancellableTier, accessUntil: string | null): string {
  const until = accessUntil
    ? `until <strong>${esc(accessUntil)}</strong>`
    : 'until the end of your current billing period'
  switch (tier) {
    case 'ark-plus':
      return `You&rsquo;ll keep early access, ad-free listening, and exclusive content ${until}. After that, you&rsquo;ll be back on the free, ad-supported shows.`
    case 'circle':
      return `You&rsquo;ll keep access to the Fold ${until}.`
    case 'bundle':
      return `You&rsquo;ll keep Ark+ and the Fold ${until}. After that, you&rsquo;ll be back on the free, ad-supported shows, and your Fold access ends.`
  }
}

export type CancellationEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  tier: CancellableTier
  // The end of the paid-through period, formatted with its zone (e.g.
  // "October 14, 2026 ET"). Null when unreadable — the copy then says "the end
  // of your current billing period" rather than inventing a date.
  accessUntil: string | null
  // Where "Tell us why" lands.
  feedbackUrl: string
  // The account page, for the undo: a cancel lands at period end, so it is
  // reversible until then — and a mis-click is the likeliest reason this email
  // is being read at all.
  accountUrl: string
}

export function renderCancellationEmail(p: CancellationEmailParams): {
  subject: string
  html: string
} {
  const label = TIER_EMAIL_LABEL[p.tier]
  const noun = p.tier === 'ark-plus' ? 'subscription' : 'membership'
  const subject = `Your ${label} ${noun} has been canceled`

  const html = renderShell({
    preheader: 'You won&rsquo;t be charged again. Here&rsquo;s what happens next.',
    headlineHtml: `Your ${label} ${noun} has been ${accent('canceled.')}`,
    sublineHtml: 'You won&rsquo;t be charged again.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      whatYouKeep(p.tier, p.accessUntil),
      `Changed your mind? Restart from ${link(p.accountUrl, 'your account')} any time before then.`,
      WHY_WE_EXIST[p.tier],
    ],
    action: {
      eyebrow: 'One question',
      headingHtml: `Why did you ${accent('cancel?')}`,
      bodyHtml: 'It takes a minute, and it helps us improve.',
      href: p.feedbackUrl,
      label: 'Tell us why',
    },
    closingHtml: 'Thank you for being a member. We hope to see you again soon.',
    footerHtml: MANAGE_FOOTER,
  })

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Debundle — one product removed, the other kept
// ---------------------------------------------------------------------------

export type DebundleEmailParams = {
  firstName?: string
  // The half being dropped. The other is kept.
  removed: 'ark-plus' | 'circle'
  // When the removal lands — formatted, same rules as accessUntil above.
  effectiveOn: string | null
  // What the kept half continues at, pre-formatted in the subscription's
  // currency (e.g. "$8"). Omitted when unreadable; the copy then names no figure.
  price?: string
  plan: BillingPlan
  accountUrl: string
}

// A partial cancellation: what stops, what continues, and when. The price is
// here because the recurring amount changes and Stripe's receipt for it doesn't
// arrive until the next bill.
export function renderDebundleEmail(p: DebundleEmailParams): {
  subject: string
  html: string
} {
  // "The Fold" is the product, as a subject or headline names it; "the Fold"
  // is how it reads mid-sentence.
  const removedLabel = p.removed === 'circle' ? 'The Fold' : 'Ark+'
  const removedHeadline = p.removed === 'circle' ? 'the Fold' : 'Ark+'
  const keptInline = p.removed === 'circle' ? 'Ark+' : 'the Fold'
  const removedInline = removedHeadline
  const when = p.effectiveOn
    ? `until <strong>${esc(p.effectiveOn)}</strong>`
    : 'until the end of your current billing period'

  const after =
    p.removed === 'circle'
      ? 'After that, your Fold access ends. Early access, ad-free listening, and exclusive content carry on as they are.'
      : 'After that, you&rsquo;ll be back on the free, ad-supported shows. Your place in the Fold carries on as it is.'

  const priceSentence = p.price
    ? `Your membership will be <strong>${esc(p.price)} ${perPeriod(p.plan)}</strong> for ${keptInline}. You&rsquo;ll see it on your next bill.`
    : `Your membership will cover ${keptInline} alone. You&rsquo;ll see the new amount on your next bill.`

  const html = renderShell({
    preheader: `${p.removed === 'circle' ? 'Ark+' : 'The Fold'} carries on. Here&rsquo;s what changes.`,
    headlineHtml: `You&rsquo;ve removed ${accent(`${removedHeadline}.`)}`,
    sublineHtml: `${p.removed === 'circle' ? 'Ark+' : 'The Fold'} carries on as it is.`,
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      `Nothing changes today. You&rsquo;ll keep ${removedInline} ${when}. ${after}`,
      priceSentence,
      `Changed your mind? Add ${removedInline} back from ${link(p.accountUrl, 'your account')} before then. ${supportLine()}`,
    ],
    action: { href: p.accountUrl, label: 'View my membership' },
    footerHtml: MANAGE_FOOTER,
  })

  return {
    subject: `You've removed ${removedLabel} from your membership`,
    html,
  }
}
