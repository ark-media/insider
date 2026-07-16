// The feed-setup reminder email. Sent by the reminder cron to members who
// joined but haven't finished setting up their private feeds. Reuses the Ark+
// brand shell from welcome-email so it looks like the rest of the lifecycle.
// Pure (no I/O) so it's trivially testable.

import { BRAND_CYAN, esc, renderShell } from './welcome-email.js'

export type FeedReminderEmailParams = {
  firstName?: string
  // How many of the member's feeds are already set up, out of how many total.
  doneCount: number
  total: number
  // The setup hub — where the CTA lands (Spotify one-click + per-show list).
  setupUrl: string
}

export function renderFeedReminderEmail(p: FeedReminderEmailParams): {
  subject: string
  html: string
} {
  const first = p.firstName?.trim().split(' ')[0] || undefined
  const remaining = Math.max(0, p.total - p.doneCount)
  const showWord = remaining === 1 ? 'show' : 'shows'
  const started = p.doneCount > 0

  const subject = started
    ? `You're ${remaining} ${showWord} away from the full network`
    : 'Finish setting up your Ark+ feeds'

  const headlineHtml = started
    ? `You're ${remaining} ${showWord} away.`
    : 'Set up your private feeds.'

  // Lead with the outcome, then push the one-click Spotify path (link once →
  // every show) that the hub features up top.
  const bodyHtml = started
    ? `You've set up ${p.doneCount} of your ${p.total} Ark+ private feeds — there ${remaining === 1 ? 'is' : 'are'} still ${remaining} ${showWord} waiting for you. The fastest way to get the rest is to <a href="${p.setupUrl}" style="color:${BRAND_CYAN};">link Spotify once</a> — it follows every show in the network automatically. Or add each show to the podcast app you already use.`
    : `Your Ark+ membership unlocks a private feed for all ${p.total} shows in the network — but you haven't set any up yet, so new episodes aren't reaching you. The fastest way in is to <a href="${p.setupUrl}" style="color:${BRAND_CYAN};">link Spotify once</a> and follow the whole network automatically. Prefer another app? Set up each show by hand from the same page.`

  const html = renderShell({
    preheader: started
      ? `${remaining} more ${showWord} to add to your podcast app.`
      : 'Add your Ark+ shows to your podcast app.',
    eyebrow: 'Finish setup',
    headlineHtml,
    greetingHtml: first ? `Hi ${esc(first)},` : 'Hi there,',
    bodyHtml,
    ctaHref: p.setupUrl,
    ctaLabel: started ? 'Add the rest' : 'Set up my feeds',
    ctaFollowupHtml: `It takes about a minute. You can always change apps later from your account.`,
    footerHtml:
      'You’re getting this because your Ark+ feeds aren’t fully set up yet. Once they are, we’ll stop sending these. Need help? Just reply to this email.',
  })

  return { subject, html }
}
