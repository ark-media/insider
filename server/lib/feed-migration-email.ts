// The feed-migration check-in emails — the escalating series sent to members
// carried over from the old feed who haven't moved to their new one. They
// follow the launch-day "move your feed" email (feed-move-email.ts), and unlike
// it they name the switch-off date: by now the date is the argument.
//
// Three stages share a shape (what's unfinished → the button → what it costs
// not to) and differ in temperature, so they share a renderer.
//
// Pure (no I/O) so they're trivially testable.

import { accent, esc, greeting, link, renderShell, SUPPORT_EMAIL, supportLine } from './email-layout.js'
import type { MigrationStage } from '../../shared/feed-migration.js'

export type MigrationEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName.
  firstName?: string
  stage: MigrationStage
  // The setup hub — Spotify one-click plus the per-show list.
  setupUrl: string
  // The switch-off date, formatted for display ("December 31, 2026").
  deadline: string
  // Whole calendar days until the deadline, counted in the zone the date was
  // formatted in. Computed, never a literal: a cron that slips a day would
  // otherwise promise five days on the fourth.
  daysRemaining: number
}

// What stops reaching them, named once the pitch has failed.
const AT_RISK =
  'the subscriber-exclusive Friday Q&amp;A, early access to Wednesday&rsquo;s Call me Back, and ad-free listening'

const FOOTER =
  'You&rsquo;re getting this because your Ark+ feed isn&rsquo;t set up yet. Once it is, we&rsquo;ll stop sending these. Need help? Just reply to this email.'

const HOW =
  'Connect Spotify once, or add a private feed for each show in your podcast app. It should take about 5 minutes.'

// The launch email's reassurance, for the stage where fear of losing the
// membership is the likeliest reason nobody has acted.
const NOT_CHANGING = {
  eyebrow: 'What&rsquo;s not changing',
  items: [
    { title: 'Same price', bodyHtml: 'You pay what you already pay.' },
    { title: 'Same account', bodyHtml: 'You sign in with the account you already use.' },
    { title: 'Same billing', bodyHtml: 'Nothing changes about how you&rsquo;re billed.' },
  ],
}

export function renderMigrationCheckInEmail(p: MigrationEmailParams): {
  subject: string
  html: string
} {
  const greetingHtml = greeting(p.firstName)
  const deadline = esc(p.deadline)

  if (p.stage === 'check_in_30') {
    return {
      subject: 'Finish moving your Ark+ feed',
      html: renderShell({
        preheader: 'It takes about 5 minutes, and unlocks the whole network.',
        headlineHtml: `Finish moving your ${accent('feed.')}`,
        sublineHtml: 'Every Ark Media show. More exclusive content. Same price.',
        greetingHtml,
        bodyHtml: [
          'You haven&rsquo;t moved to your new Ark+ feed yet. Once you do, you get early access, ad-free listening, and exclusive content across every show in the network.',
          `Your old Call me Back feed switches off on <strong>${deadline}</strong>.`,
        ],
        sections: [
          {
            eyebrow: 'What you now get',
            headingHtml: `One membership.<br />The whole ${accent('network.')}`,
            shows: true,
          },
        ],
        action: {
          eyebrow: 'What you need to do',
          headingHtml: `Move your podcast feed to the new ${accent('platform.')}`,
          bodyHtml: HOW,
          href: p.setupUrl,
          label: 'Move my feed',
        },
        closingHtml: `Thank you for being a member. ${supportLine()}`,
        footerHtml: FOOTER,
      }),
    }
  }

  if (p.stage === 'check_in_60') {
    return {
      subject: "You're about to lose early access to Call me Back",
      html: renderShell({
        preheader: `Move your feed before ${deadline} to keep your benefits.`,
        headlineHtml: `Your Ark+ benefits are ${accent('at risk.')}`,
        sublineHtml: `Your old feed switches off on ${deadline}.`,
        greetingHtml,
        bodyHtml: [
          `You still haven&rsquo;t moved your Call me Back feed. If you don&rsquo;t by <strong>${deadline}</strong>, you&rsquo;ll lose ${AT_RISK}.`,
          'Everything else about your membership stays the same.',
        ],
        action: {
          eyebrow: 'What you need to do',
          headingHtml: `Move your feed ${accent('today.')}`,
          bodyHtml: HOW,
          href: p.setupUrl,
          label: 'Move my feed',
        },
        closingHtml: supportLine(),
        footerHtml: FOOTER,
      }),
    }
  }

  const days = Math.max(0, p.daysRemaining)
  const countdown = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`
  const daysLabel = days === 0 ? 'Last day' : days === 1 ? '1 day left' : `${days} days left`

  return {
    subject: `${daysLabel} to keep your Call me Back benefits`,
    html: renderShell({
      preheader: `Your old feed switches off on ${deadline}. Here&rsquo;s what to do.`,
      kicker: 'Final reminder',
      headlineHtml: `${daysLabel} to move your ${accent('feed.')}`,
      sublineHtml: `${countdown}, on ${deadline}, your old Call me Back feed switches off.`,
      greetingHtml,
      bodyHtml: [
        `This is only about where your episodes are delivered, like changing a mailing address. Until you switch, new episodes stop showing up in your app, including ${AT_RISK}.`,
      ],
      sections: [NOT_CHANGING],
      action: {
        eyebrow: 'What you need to do',
        headingHtml: `Move your feed ${accent('now.')}`,
        bodyHtml: HOW,
        href: p.setupUrl,
        label: 'Move my feed',
      },
      closingHtml: `Stuck? Email ${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)} right away and we&rsquo;ll help.`,
      footerHtml:
        'You&rsquo;re getting this because your Ark+ feed isn&rsquo;t set up yet. This is the last email in this series. Need help? Just reply to this email.',
    }),
  }
}
