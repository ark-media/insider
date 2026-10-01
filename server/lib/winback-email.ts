// The 180-day win-back emails. Sent by the win-back cron to members who left
// six months ago and haven't come back: one for Ark+ leavers, one for Fold
// leavers, one for members who left both. Pure (no I/O) so all three are
// trivially testable.
//
// Marketing to someone who is no longer a customer, so unlike every other
// member email each carries its own unsubscribe link.

import { accent, BRAND_FG_MUTED, esc, greeting, renderShell, type EmailItem } from './email-layout.js'
import { getShow } from '../../src/data/shows.js'

// The flagship members-only show, named as the app names it.
function premiumShowTitle(): string {
  return getShow('call-me-back-plus')?.title ?? 'our members-only show'
}

export type WinbackEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  // Where the button lands — the membership pitch with its checkout.
  rejoinUrl: string
  // The one-click unsubscribe for this campaign.
  unsubscribeUrl: string
}

function arkPlusItems(): EmailItem[] {
  return [
    { title: 'Bonus episodes', bodyHtml: `Subscriber-only episodes, including ${esc(premiumShowTitle())}.` },
    { title: 'Live Q&amp;As', bodyHtml: 'With Dan Senor, Donniel Hartman, Yossi Klein Halevi, and our other hosts.' },
    { title: 'Early access', bodyHtml: 'New episodes two days before they go public.' },
    { title: 'Ad-free listening', bodyHtml: 'Across every Ark Media show.' },
  ]
}

const FOLD_ITEMS: EmailItem[] = [
  { title: 'The conversation', bodyHtml: 'Members who share a curiosity about the Jewish experience.' },
  { title: 'Live events', bodyHtml: 'Member events and Q&amp;As.' },
  { title: 'Book club', bodyHtml: 'Read along with Dan&rsquo;s book club.' },
]

function footer(what: string, unsubscribeUrl: string): string {
  return `You&rsquo;re getting this because you were ${what}. <a href="${unsubscribeUrl}" style="color:${BRAND_FG_MUTED};">Unsubscribe from win-back emails</a>.`
}

export function renderWinbackEmail(p: WinbackEmailParams): {
  subject: string
  html: string
} {
  const html = renderShell({
    preheader: 'Six months of debate and discovery, and a few episodes we think you&rsquo;ll want back.',
    headlineHtml: `We saved your ${accent('seat.')}`,
    sublineHtml: 'Rejoining takes less than a minute.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      'It&rsquo;s been six months since you left Ark+, and the questions about Israel and Jewish life haven&rsquo;t gotten any simpler. They&rsquo;re not the kind an algorithm rewards covering. Member support is what lets us keep asking them.',
    ],
    sections: [{ eyebrow: 'What you get back', items: arkPlusItems() }],
    action: {
      headingHtml: `Come back to ${accent('Ark+.')}`,
      bodyHtml: 'Full access again right away. Cancel any time.',
      href: p.rejoinUrl,
      label: 'Rejoin Ark+',
    },
    closingHtml: 'Hope to see you again soon.',
    footerHtml: footer('an Ark+ member', p.unsubscribeUrl),
  })

  return { subject: 'We saved your seat', html }
}

// "Your profile is still there" holds because cancelling moves a member to the
// Fold's cancelled access group; it never deletes them.
export function renderFoldWinbackEmail(p: WinbackEmailParams): {
  subject: string
  html: string
} {
  const html = renderShell({
    preheader: 'Six months of conversations, member events and Dan&rsquo;s book club since you left.',
    headlineHtml: `The conversation kept ${accent('going.')}`,
    sublineHtml: 'Your profile is still there, just as you left it.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      'It&rsquo;s been six months since you left the Fold. Some days the conversation is the hardest questions facing Jewish life. Other days it&rsquo;s a good recipe, or a joke only a few people will get.',
    ],
    sections: [{ eyebrow: 'What you get back', items: FOLD_ITEMS }],
    action: {
      headingHtml: `Come back to ${accent('the Fold.')}`,
      bodyHtml: 'Rejoining takes less than a minute. Cancel any time.',
      href: p.rejoinUrl,
      label: 'Rejoin the Fold',
    },
    closingHtml: 'Hope to see you again soon.',
    footerHtml: footer('a member of the Fold', p.unsubscribeUrl),
  })

  return { subject: 'The conversation kept going', html }
}

// For a member who left both Ark+ and the Fold: one email inviting them back to
// both, rather than the Ark+ one and the Fold one.
export function renderBundleWinbackEmail(p: WinbackEmailParams): {
  subject: string
  html: string
} {
  const html = renderShell({
    preheader: 'Six months of debate, discovery and conversation, and a few episodes we think you&rsquo;ll want back.',
    headlineHtml: `We saved your ${accent('seat.')}`,
    sublineHtml: 'Your Fold profile is still there, just as you left it.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      'It&rsquo;s been six months since you left Ark+ and the Fold. The questions about Israel and Jewish life haven&rsquo;t gotten any simpler, and the conversation in the Fold hasn&rsquo;t stopped. Member support keeps both going.',
    ],
    sections: [{ eyebrow: 'What you get back', items: [...arkPlusItems(), ...FOLD_ITEMS] }],
    action: {
      headingHtml: `Come back to Ark+ and ${accent('the Fold.')}`,
      bodyHtml: 'Full access again right away. Cancel any time.',
      href: p.rejoinUrl,
      label: 'Rejoin Ark+ and the Fold',
    },
    closingHtml: 'Hope to see you again soon.',
    footerHtml: footer('a member of Ark+ and the Fold', p.unsubscribeUrl),
  })

  return { subject: 'We saved your seat', html }
}
