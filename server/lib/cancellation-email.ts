// The cancellation-confirmation emails, and their partial sibling: the debundle
// notice. Both say the same three things — what you're losing, what you keep,
// and the date the change lands — so they share a module and a shape.
//
// Copy for the three cancellation variants is the "Lifecycle Emails & Member
// Communications" doc. The debundle notice is NOT in that doc (it has no entry
// for removing one product from a bundle), so its wording is written here,
// modelled on the cancellation copy.
//
// Pure (no I/O) so they're trivially testable; the routes hand the result to
// sendEmail().

import {
  ARK_MEDIA_TEAM,
  MANAGE_FOOTER,
  esc,
  link,
  renderShell,
  supportLine,
} from './welcome-email.js'
import { perPeriod, type BillingPlan } from '../../shared/billing-copy.js'

// The tier being left. 'free' never reaches these renderers — there is nothing
// to cancel — so it is deliberately not in the union.
export type CancellableTier = 'ark-plus' | 'circle' | 'bundle'

// What a member sees their membership called, in the POSSESSIVE position —
// "your ___ membership". That is the only position these labels are used in
// (both the cancellation subject and the failed-payment body), and it is why
// the Fold appears here without its article: "your The Fold membership" is not
// a sentence. The copy doc writes it the same way.
//
// The client has its own copies of this map (CheckoutModal, the billing page);
// this one is the emails' — they are the surfaces that can't be corrected after
// the fact, so they get a map that lives next to the copy it appears in.
export const TIER_EMAIL_LABEL: Record<CancellableTier, string> = {
  'ark-plus': 'Ark+',
  circle: 'Fold',
  bundle: 'Ark+ and Fold',
}

// The sentence that closes every cancellation email in the doc: why the thing
// they just left exists, and how to come back. One per tier — a Fold canceller
// is not owed a paragraph about ad-free listening.
const WHY_WE_EXIST: Record<CancellableTier, string> = {
  'ark-plus':
    'Ark+ is what makes all of this possible, honest coverage of Israel and the Jewish world, funded by members instead of advertisers or algorithms. If you&rsquo;d like to keep supporting that, sign up again anytime at arkmedia.org. We hope to see you again soon.',
  circle:
    'The Fold exists so this community has a place to actually talk to each other, debate, and yes, sometimes just share a joke or a recipe, without the noise everywhere else online. If you&rsquo;d like to be part of that again, you can rejoin anytime at arkmedia.org. We hope to see you back in there soon.',
  bundle:
    'Ark+ is what lets us cover Israel and the Jewish world honestly, funded by members instead of advertisers or algorithms. The Fold is what gives this community a place to actually talk to each other. If you&rsquo;d like to be part of either again, you can resubscribe anytime at arkmedia.org. We hope to see you back soon.',
}

// What actually stops working, and when. The doc states the end date inside
// this sentence rather than as a standalone line, which is what keeps "you
// still have access" and "until when" from being read separately.
function whatYouKeep(tier: CancellableTier, accessUntil: string | null): string {
  const through = accessUntil ? ` through <strong>${esc(accessUntil)}</strong>` : ''
  switch (tier) {
    case 'ark-plus':
      return `You&rsquo;ll keep your current benefits, ad-free listening, early access, and exclusive content across the network,${through || ' until the end of your current billing period'}. After that, you&rsquo;ll return to the free, ad-supported version of our shows.`
    case 'circle':
      return `You&rsquo;ll keep access${through || ' until the end of your current billing period'}. After that, you&rsquo;ll lose access to The Fold.`
    case 'bundle':
      return `You&rsquo;ll keep access to both${through || ' until the end of your current billing period'}. After that, your Ark+ benefits end and you&rsquo;ll shift back to the free, ad-supported version of our shows. Your Fold access ends entirely, no more logging in.`
  }
}

export type CancellationEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName,
  // which is what rejects a name manufactured from the member's email.
  firstName?: string
  tier: CancellableTier
  // The end of the paid-through period, already formatted for display and
  // carrying the zone it's stated in (e.g. "October 14, 2026 ET"). Null when
  // Stripe gave no readable period end — the copy then says "the end of your
  // current billing period" rather than inventing a date.
  accessUntil: string | null
  // [FEEDBACK LINK PLACEHOLDER] in the doc. Where "tell us why" lands.
  feedbackUrl: string
  // The account page, for the undo. A cancel is scheduled at period end, so it
  // is reversible right up until it lands — and a mis-click is the single most
  // likely reason this email is being read at all.
  accountUrl: string
}

export function renderCancellationEmail(p: CancellationEmailParams): {
  subject: string
  html: string
} {
  const first = p.firstName?.trim() || undefined
  const label = TIER_EMAIL_LABEL[p.tier]
  const noun = p.tier === 'ark-plus' ? 'subscription' : 'membership'

  // The doc's headline is the subject in sentence case. Kept identical on
  // purpose: this is the one email whose subject is the whole message, and a
  // headline that restates it is what confirms the reader didn't misread.
  const subject = `Your ${label} ${noun} has been canceled`

  const confirms =
    p.tier === 'bundle'
      ? 'This confirms your bundle subscription, covering both Ark+ and The Fold, has been canceled. You won&rsquo;t be charged again.'
      : `This confirms your ${label} ${noun} has been canceled. You won&rsquo;t be charged again.`

  const html = renderShell({
    preheader: "Here's what happens next.",
    eyebrow: 'Cancellation confirmed',
    headlineHtml: `Your ${label} ${noun} has been canceled.`,
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml: confirms,
    bodySecondHtml: whatYouKeep(p.tier, p.accessUntil),
    ctaHref: p.feedbackUrl,
    ctaLabel: 'Tell us why',
    ctaFollowupHtml:
      'If you have a moment, we&rsquo;d love to know why you canceled. It helps us keep improving.',
    sections: [{ paragraphs: [WHY_WE_EXIST[p.tier]] }],
    signoffHtml: ARK_MEDIA_TEAM,
    // Not in the doc, and the most useful line in the email: the cancel is
    // scheduled, not done, so it can still be undone from the account page.
    // Someone who cancelled by mistake has no other way to learn that.
    footerHtml: `Changed your mind? You can restart your ${noun} from ${link(
      p.accountUrl,
      'your account',
    )} any time before it ends. Need help? Just reply to this email.`,
  })

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Debundle — one product removed, the other kept
// ---------------------------------------------------------------------------

export type DebundleEmailParams = {
  firstName?: string
  // The axis being dropped. The other one is kept, which is what makes this a
  // debundle rather than a cancellation.
  removed: 'ark-plus' | 'circle'
  // When the removal lands — already formatted, same rules as accessUntil above.
  effectiveOn: string | null
  // What the kept product continues at, pre-formatted in the currency the
  // subscription actually bills in (e.g. "$8"). Omitted when unreadable, and
  // the copy then drops the figure rather than guessing one.
  price?: string
  plan: BillingPlan
  accountUrl: string
}

// Not in the copy doc. A debundle is a partial cancellation and the member has
// the same three questions — what stops, what continues, and when — so this
// follows the cancellation shape rather than inventing a new one. The price is
// here because a debundle changes the recurring amount, and Stripe's receipt
// for the new amount doesn't arrive until the next invoice.
export function renderDebundleEmail(p: DebundleEmailParams): {
  subject: string
  html: string
} {
  const first = p.firstName?.trim() || undefined
  // Two forms of each name. "The Fold" is the product, and it is what a subject
  // line or a button says; "the Fold" is how it reads inside a sentence. Mixing
  // them in one paragraph — which this copy did — looks like two things.
  const removedLabel = p.removed === 'circle' ? 'The Fold' : 'Ark+'
  const keptLabel = p.removed === 'circle' ? 'Ark+' : 'The Fold'
  const removedInline = p.removed === 'circle' ? 'the Fold' : 'Ark+'
  const keptInline = p.removed === 'circle' ? 'Ark+' : 'the Fold'
  const when = p.effectiveOn
    ? `on <strong>${esc(p.effectiveOn)}</strong>`
    : 'at the end of your current billing period'

  const losing =
    p.removed === 'circle'
      ? `After that you&rsquo;ll lose access to the Fold, and your Ark+ benefits — ad-free listening, early access, and exclusive content across the network — carry on exactly as they are.`
      : `After that you&rsquo;ll return to the free, ad-supported version of our shows, and your place in the Fold carries on exactly as it is.`

  const priceSentence = p.price
    ? `Your membership is now <strong>${esc(p.price)} ${perPeriod(p.plan)}</strong>, and that covers ${keptInline}.`
    : `Your membership now covers ${keptInline} alone.`

  const html = renderShell({
    preheader: `${keptLabel} continues. Here's what changes.`,
    eyebrow: 'Membership updated',
    headlineHtml: `You&rsquo;ve removed ${removedLabel} from your membership.`,
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml: `This confirms you&rsquo;re keeping ${keptInline} and dropping ${removedInline}. Nothing changes today — ${removedInline} stays yours until the change takes effect ${when}. ${losing}`,
    bodySecondHtml: `${priceSentence} You&rsquo;ll see the new amount on your next bill.`,
    ctaHref: p.accountUrl,
    ctaLabel: 'View my membership',
    ctaFollowupHtml: `Changed your mind? You can add ${removedInline} back from ${link(
      p.accountUrl,
      'your account',
    )} before the change lands. ${supportLine()}`,
    signoffHtml: ARK_MEDIA_TEAM,
    footerHtml: MANAGE_FOOTER,
  })

  return {
    subject: `You've removed ${removedLabel} from your membership`,
    html,
  }
}
