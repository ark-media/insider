// The feed-setup reminder email. Sent by the reminder cron to members who
// joined but haven't finished setting up their private feeds. Pure (no I/O) so
// it's trivially testable.

import { accent, greeting, MANAGE_FOOTER, renderShell, supportLine } from './email-layout.js'

export type FeedReminderEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  // How many of the member's feeds are already set up, out of how many total.
  doneCount: number
  total: number
  // The setup hub — where the button lands.
  setupUrl: string
}

export function renderFeedReminderEmail(p: FeedReminderEmailParams): {
  subject: string
  html: string
} {
  const remaining = Math.max(0, p.total - p.doneCount)
  const showWord = remaining === 1 ? 'show' : 'shows'
  const started = p.doneCount > 0

  const subject = started
    ? `You're ${remaining} ${showWord} away from the full network`
    : 'Finish setting up your Ark+ membership'

  const html = renderShell({
    preheader: started
      ? `${remaining} more ${showWord} to add. It takes a few minutes.`
      : 'Set up your private feed. It takes about 5 minutes.',
    headlineHtml: started
      ? `You&rsquo;re ${remaining} ${showWord} ${accent('away.')}`
      : `Set up your ${accent('private feed.')}`,
    sublineHtml: 'Every Ark Media show. More exclusive content.',
    greetingHtml: greeting(p.firstName),
    bodyHtml: [
      started
        ? `You&rsquo;ve set up ${p.doneCount} of your ${p.total} private feeds. ${remaining} ${showWord} still ${remaining === 1 ? 'needs' : 'need'} adding before every new episode reaches you.`
        : `Your membership covers all ${p.total} shows, but none of your private feeds are set up yet, so new episodes aren&rsquo;t reaching you.`,
    ],
    action: {
      eyebrow: 'What you need to do',
      headingHtml: started ? `Add the ${accent('rest.')}` : `Set it up ${accent('today.')}`,
      bodyHtml: 'Connect Spotify once to follow every show, or add each show to the podcast app you already use. It should take about 5 minutes.',
      href: p.setupUrl,
      label: started ? 'Add the rest' : 'Set up my feed',
    },
    closingHtml: supportLine(),
    footerHtml: `You&rsquo;re getting this because your Ark+ feeds aren&rsquo;t fully set up yet. Once they are, we&rsquo;ll stop sending these. ${MANAGE_FOOTER}`,
  })

  return { subject, html }
}
