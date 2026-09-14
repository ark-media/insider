// The feed-migration check-in emails — the escalating series sent to members
// carried over from the old feed who haven't moved to their new one.
//
// Copy is the "Lifecycle Emails & Member Communications" doc: the 30-day
// check-in, the 60-day check-in, and the final notice. The three share a shape
// (what's unfinished → the setup link → what it costs you not to) and differ in
// temperature, so they share a renderer and branch on the stage.
//
// Pure (no I/O) so they're trivially testable.

import {
  ARK_MEDIA_TEAM,
  SUPPORT_EMAIL,
  esc,
  link,
  networkShowBullets,
  renderShell,
  supportLine,
} from './welcome-email.js'
import type { MigrationStage } from '../../shared/feed-migration.js'

export type MigrationEmailParams = {
  // Already a clean first name — callers resolve it through greetingFirstName,
  // which is what rejects a name manufactured from the member's email.
  firstName?: string
  stage: MigrationStage
  // The setup hub — Spotify one-click plus the per-show list.
  setupUrl: string
  // The switch-off date, formatted for display ("December 31, 2026"). The copy
  // names it in every stage, so it is never optional.
  deadline: string
  // Whole calendar days until the deadline, counted in the same zone the date
  // was formatted in. The final notice leads with this, and computes it rather
  // than repeating the doc's literal "5" — a cron that slips a day would
  // otherwise tell members they have five days left on the day before.
  daysRemaining: number
}

// The benefits at stake, which get more specific as the series escalates. The
// 60-day and final emails name the three things that actually stop working,
// because by then the abstraction ("your benefits") has already failed to move
// anyone.
const AT_RISK =
  'our subscriber-exclusive Friday Q&amp;A episode, early access to the Wednesday episode of Call Me Back, and ad-free listening'

// "Podcast app users set up a new feed for each show. Spotify users connect
// once and get everything." Every stage carries it — it is the answer to "how
// long will this take", which is the actual objection.
function howSetupWorks(setupUrl: string): string {
  return (
    `Setup looks slightly different depending on how you listen. Podcast app ` +
    `users add a new feed for each show; Spotify users ${link(
      setupUrl,
      'connect once',
    )} and get everything.`
  )
}

export function renderMigrationCheckInEmail(p: MigrationEmailParams): {
  subject: string
  html: string
} {
  const first = p.firstName?.trim() || undefined
  const greeting = first ? `Hi ${esc(first)},` : 'Hi there,'
  const deadline = esc(p.deadline)
  const setupLink = link(p.setupUrl, 'arkmedia.org/setup')

  if (p.stage === 'check_in_30') {
    return {
      subject: 'Finish setting up your Ark+ membership',
      html: renderShell({
        preheader: 'It takes about 5 minutes, and unlocks the whole network.',
        eyebrow: 'Finish setup',
        headlineHtml: 'Finish setting up your Ark+ membership.',
        greetingHtml: greeting,
        bodyHtml:
          "It looks like you haven&rsquo;t finished moving to your new Ark+ feeds yet. It takes about five minutes.",
        bodySecondHtml: `Once you&rsquo;re set up, you&rsquo;ll get ad-free listening, early access, and exclusive content across every show in the network, not just Call Me Back, plus our subscriber-exclusive newsletter.`,
        ctaHref: p.setupUrl,
        ctaLabel: 'Finish setup',
        ctaFollowupHtml: `${howSetupWorks(p.setupUrl)} ${supportLine(
          'If you run into any trouble',
        )}`,
        sections: [
          // The doc's VISUAL BENEFITS LIST. The paragraph above promises "every
          // show in the network, not just Call Me Back" — this is the half that
          // says which shows those are, which is the whole argument for moving.
          // Only the 30-day stage carries it: by 60 days the pitch has already
          // failed, and those emails escalate to what stops working instead.
          //
          // Same source as the welcome emails (src/data/shows.ts), so a show
          // joining or leaving the network reaches both without a second edit.
          {
            heading: "What's waiting for you",
            bullets: networkShowBullets(),
          },
          {
            paragraphs: [
              `Your old Call Me Back feed will be turned off on <strong>${deadline}</strong>, so it&rsquo;s worth knocking this out now rather than later.`,
            ],
          },
        ],
        signoffHtml: `Thank you for being a member.<br />${ARK_MEDIA_TEAM}`,
        footerHtml: `You&rsquo;re getting this because your Ark+ feeds aren&rsquo;t set up yet. Once they are, we&rsquo;ll stop sending these. Set up at ${setupLink}.`,
      }),
    }
  }

  if (p.stage === 'check_in_60') {
    return {
      subject: "You're about to lose early access to Call Me Back",
      html: renderShell({
        preheader: `Complete your feed migration before ${deadline} to keep these benefits.`,
        eyebrow: 'Benefits at risk',
        headlineHtml: 'Your Ark+ benefits are at risk.',
        greetingHtml: greeting,
        bodyHtml:
          'It looks like you still haven&rsquo;t finished migrating your Call Me Back feed.',
        // The escalation is entirely in this sentence: name the three things,
        // and put the date on them.
        bodySecondHtml: `If you don&rsquo;t complete this before <strong>${deadline}</strong>, you&rsquo;ll lose ${AT_RISK}.`,
        ctaHref: p.setupUrl,
        ctaLabel: 'Finish setup',
        ctaFollowupHtml: `${howSetupWorks(p.setupUrl)} ${supportLine(
          'If you run into any trouble',
        )}`,
        sections: [
          {
            paragraphs: [
              'Everything else about your membership continues once you make this one switch — ad-free listening, exclusive content across the network, and our subscriber newsletter.',
            ],
          },
        ],
        signoffHtml: ARK_MEDIA_TEAM,
        footerHtml: `You&rsquo;re getting this because your Ark+ feeds aren&rsquo;t set up yet. Once they are, we&rsquo;ll stop sending these. Set up at ${setupLink}.`,
      }),
    }
  }

  // Final notice. The countdown is computed, never the doc's literal "5": a
  // cron that slips a day would otherwise promise five days on the fourth.
  const days = Math.max(0, p.daysRemaining)
  const countdown =
    days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`
  const daysLabel =
    days === 0
      ? 'Last day'
      : days === 1
        ? '1 day left'
        : `${days} days left`

  return {
    subject: `${daysLabel} to keep your Call Me Back benefits`,
    html: renderShell({
      preheader: `Your feed migration deadline is ${deadline}. Here's what to do.`,
      eyebrow: 'Final reminder',
      headlineHtml: `${daysLabel} to keep your Call Me Back benefits.`,
      greetingHtml: greeting,
      bodyHtml: `This is your final reminder. ${countdown}, on <strong>${deadline}</strong>, your old Call Me Back feed will be turned off.`,
      // The fear this defuses is the expensive one: a member who thinks their
      // subscription is ending behaves very differently from one who knows it
      // is a delivery address change.
      bodySecondHtml: `Your subscription and payment aren&rsquo;t affected. This is only about where your episodes get delivered, like changing the address they get mailed to. Once you make the switch everything works exactly as it should — but until you do, new episodes and your subscriber benefits will stop showing up, including ${AT_RISK}.`,
      ctaHref: p.setupUrl,
      ctaLabel: 'Finish setup now',
      ctaFollowupHtml:
      `${howSetupWorks(p.setupUrl)} If you run into any trouble, reach out to us ` +
      `right away at ${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)} — we want ` +
      `to help you keep receiving everything you&rsquo;re already paying for.`,
      signoffHtml: ARK_MEDIA_TEAM,
      footerHtml: `You&rsquo;re getting this because your Ark+ feeds aren&rsquo;t set up yet. This is the last email in this series either way. Set up at ${setupLink}.`,
    }),
  }
}
