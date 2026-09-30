// The 180-day win-back emails. Sent by the win-back cron to members who left
// six months ago and haven't come back, inviting them to resubscribe: one for
// Ark+ leavers, one for Fold leavers, one for members who left both.
//
// The Ark+ copy is the "Lifecycle Emails & Member Communications" doc, "Ark+
// 180 Day Winback". The Fold one isn't in the doc; Hannah approved its wording
// 2026-09-27, and it only repeats claims the site already makes about the Fold
// (the tier card, /fold, the Fold welcome email). The Bundle one isn't in the
// doc either: it is the Ark+ and Fold emails merged, making no claim the two of
// them don't already make; Hannah approved it 2026-09-27. Pure (no I/O) so all
// three are trivially testable.

import {
  ARK_MEDIA_TEAM,
  BRAND_FG_MUTED,
  esc,
  greeting,
  renderShell,
} from './welcome-email.js'
import { getShow } from '../../src/data/shows.js'

// The flagship members-only show, named as the app names it. Reading the
// title off the show data means this bullet can't drift from the product.
// Named by slug: there are several Ark+ shows, and this bullet means this one.
function premiumShowTitle(): string {
  return getShow('call-me-back-plus')?.title ?? 'our members-only show'
}

export type WinbackEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName,
  // which is what rejects a name manufactured from the member's email.
  firstName?: string
  // Where "Rejoin Ark+" lands — the membership pitch with its checkout.
  rejoinUrl: string
  // The one-click unsubscribe for this campaign. Unlike every other email in
  // this codebase, this one is marketing to someone who is no longer a
  // customer, so it carries its own opt-out rather than leaning on "reply to
  // this email".
  unsubscribeUrl: string
}

export function renderWinbackEmail(p: WinbackEmailParams): {
  subject: string
  html: string
} {

  const html = renderShell({
    preheader:
      'Six months of debate and discovery, and a few episodes we think you&rsquo;ll want back.',
    eyebrow: 'We saved your seat',
    headlineHtml: 'We saved your seat.',
    greetingHtml: greeting(p.firstName),
    bodyHtml:
      'It&rsquo;s been six months since you left Ark+, and the questions about Israel and Jewish life haven&rsquo;t gotten any simpler since you&rsquo;ve been gone. And they&rsquo;re not exactly the kind of questions an algorithm rewards covering. Our Ark+ member support is what lets us keep asking them anyway.',
    bodySecondHtml:
      'We&rsquo;d appreciate your support. Rejoining takes less than a minute, and you&rsquo;ll have full access again right away.',
    ctaHref: p.rejoinUrl,
    ctaLabel: 'Rejoin Ark+',
    // The benefits list sits below the CTA, so the parting line has to sit below
    // the list — not here, where it read as a sign-off with four bullets after it.
    ctaFollowupHtml:
      'Your membership picks up exactly where it left off, and you can cancel any time.',
    sections: [
      {
        heading: "When you're an Ark+ member, you also get:",
        bullets: [
          `Subscriber-only bonus episodes, including ${esc(premiumShowTitle())}`,
          'Live Q&amp;A access with Dan Senor, Donniel Hartman, Yossi Klein Halevi, and our other hosts',
          'Early access to new episodes, two days before they go public',
          'Ad-free listening across every Ark Media show',
        ],
      },
    ],
    signoffHtml: `Hope to see you again soon.<br />&mdash; ${ARK_MEDIA_TEAM}`,
    footerHtml: `You’re getting this because you were an Ark+ member. <a href="${p.unsubscribeUrl}" style="color:${BRAND_FG_MUTED};">Unsubscribe from win-back emails</a>.`,
  })

  return { subject: 'We saved your seat', html }
}

// Same shape as the Ark+ email, for a member who fully left a Fold-only
// membership. "Your profile is still there" holds because cancelling moves a
// member to the Fold's cancelled access group; it never deletes them.
export function renderFoldWinbackEmail(p: WinbackEmailParams): {
  subject: string
  html: string
} {

  const html = renderShell({
    preheader:
      'Six months of conversations, member events and Dan&rsquo;s book club since you left.',
    eyebrow: 'The conversation kept going',
    headlineHtml: 'The conversation kept going.',
    greetingHtml: greeting(p.firstName),
    bodyHtml:
      'It&rsquo;s been six months since you left the Fold, and the conversation hasn&rsquo;t stopped. Some days that means debating the hardest questions facing Jewish life right now. Other days it&rsquo;s a good recipe or a joke only a few people will get.',
    bodySecondHtml:
      'We&rsquo;d love to have you back. Rejoining takes less than a minute, and you&rsquo;ll be back inside right away.',
    ctaHref: p.rejoinUrl,
    ctaLabel: 'Rejoin the Fold',
    ctaFollowupHtml:
      'Your profile is still there, just as you left it, and you can cancel any time.',
    sections: [
      {
        heading: "When you're in the Fold, you get:",
        bullets: [
          'Conversations with members who share a curiosity about the Jewish experience',
          'Live member events and Q&amp;As',
          'Dan&rsquo;s book club',
        ],
      },
    ],
    signoffHtml: `Hope to see you again soon.<br />&mdash; ${ARK_MEDIA_TEAM}`,
    footerHtml: `You’re getting this because you were a member of the Fold. <a href="${p.unsubscribeUrl}" style="color:${BRAND_FG_MUTED};">Unsubscribe from win-back emails</a>.`,
  })

  return { subject: 'The conversation kept going', html }
}

// For a member who left both Ark+ and the Fold: a Bundle canceller, or someone
// who left each on its own. One email rather than the Ark+ one and the Fold one,
// inviting them back to both.
export function renderBundleWinbackEmail(p: WinbackEmailParams): {
  subject: string
  html: string
} {

  const html = renderShell({
    preheader:
      'Six months of debate, discovery and conversation, and a few episodes we think you&rsquo;ll want back.',
    eyebrow: 'We saved your seat',
    headlineHtml: 'We saved your seat.',
    greetingHtml: greeting(p.firstName),
    bodyHtml:
      'It&rsquo;s been six months since you left Ark+ and the Fold, and the questions about Israel and Jewish life haven&rsquo;t gotten any simpler since you&rsquo;ve been gone. The conversation in the Fold hasn&rsquo;t stopped either. Member support is what lets us keep asking those questions, and keeps a place to talk them through.',
    bodySecondHtml:
      'We&rsquo;d appreciate your support. Rejoining takes less than a minute, and you&rsquo;ll have full access again right away.',
    ctaHref: p.rejoinUrl,
    ctaLabel: 'Rejoin Ark+ and the Fold',
    ctaFollowupHtml:
      'Your Fold profile is still there, just as you left it, and you can cancel any time.',
    sections: [
      {
        heading: "As a member of Ark+ and the Fold, you get:",
        bullets: [
          `Subscriber-only bonus episodes, including ${esc(premiumShowTitle())}`,
          'Early access to new episodes, and ad-free listening across every Ark Media show',
          'Live Q&amp;A access with Dan Senor, Donniel Hartman, Yossi Klein Halevi, and our other hosts',
          'Conversations in the Fold with members who share a curiosity about the Jewish experience',
          'Live member events and Dan&rsquo;s book club',
        ],
      },
    ],
    signoffHtml: `Hope to see you again soon.<br />&mdash; ${ARK_MEDIA_TEAM}`,
    footerHtml: `You’re getting this because you were a member of Ark+ and the Fold. <a href="${p.unsubscribeUrl}" style="color:${BRAND_FG_MUTED};">Unsubscribe from win-back emails</a>.`,
  })

  return { subject: 'We saved your seat', html }
}
