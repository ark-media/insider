// The 180-day win-back email. Sent by the win-back cron to members who left
// Ark+ six months ago and haven't come back, inviting them to resubscribe.
//
// Copy is the "Lifecycle Emails & Member Communications" doc, "Ark+ 180 Day
// Winback". Pure (no I/O) so it's trivially testable.

import { ARK_MEDIA_TEAM, esc, renderShell } from './welcome-email.js'
import { shows } from '../../src/data/shows.js'

// The members-only show, named as the app names it. The doc calls it "Inside
// Call Me Back", which is what it used to be; reading the title off the show
// data means this bullet can't drift from the product again.
function premiumShowTitle(): string {
  return shows.find((s) => s.paid)?.title ?? 'our members-only show'
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
  const first = p.firstName?.trim() || undefined

  const html = renderShell({
    preheader:
      'Six months of debate and discovery, and a few episodes we think you&rsquo;ll want back.',
    eyebrow: 'We saved your seat',
    headlineHtml: 'We saved your seat.',
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
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
    footerHtml: `You’re getting this because you were an Ark+ member. <a href="${p.unsubscribeUrl}" style="color:rgba(255,255,255,0.62);">Unsubscribe from win-back emails</a>.`,
  })

  return { subject: 'We saved your seat', html }
}
