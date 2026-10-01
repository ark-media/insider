// The three migration check-in emails. Pure renderers, so these pin the thing
// that distinguishes them: temperature, and how specific each stage gets about
// what a member is about to lose.

import { describe, test, expect } from 'bun:test'
import { renderMigrationCheckInEmail } from './lib/feed-migration-email'
import { SUPPORT_EMAIL, showRows } from './lib/email-layout'
import type { MigrationStage } from '../shared/feed-migration'

const BASE = {
  setupUrl: 'https://app.test/setup',
  deadline: 'December 31, 2026',
  daysRemaining: 5,
}

const STAGES: MigrationStage[] = ['check_in_30', 'check_in_60', 'final']

describe('every stage', () => {
  test('names the deadline, links setup, and offers the support desk', () => {
    for (const stage of STAGES) {
      const { html } = renderMigrationCheckInEmail({ ...BASE, stage })
      expect(html).toContain('December 31, 2026')
      expect(html).toContain(BASE.setupUrl)
      expect(html).toContain(SUPPORT_EMAIL)
      expect(html).not.toContain('PLACEHOLDER')
      expect(html).not.toContain('undefined')
    }
  })

  test('explains that setup differs by listening app — the real objection', () => {
    for (const stage of STAGES) {
      const { html } = renderMigrationCheckInEmail({ ...BASE, stage })
      expect(html).toContain('Spotify')
      expect(html).toContain('podcast app')
    }
  })

  test('greets by first name when one is known', () => {
    for (const stage of STAGES) {
      expect(
        renderMigrationCheckInEmail({ ...BASE, stage, firstName: 'Ada' }).html,
      ).toContain('Hi Ada,')
      expect(renderMigrationCheckInEmail({ ...BASE, stage }).html).toContain('Hi there,')
    }
  })

  test('escapes a first name', () => {
    const { html } = renderMigrationCheckInEmail({
      ...BASE,
      stage: 'check_in_30',
      firstName: 'A<b>d</b>a',
    })
    expect(html).not.toContain('<b>d</b>')
  })
})

describe('30-day check-in', () => {
  test('leads with what setup unlocks, not with a threat', () => {
    const { subject, html } = renderMigrationCheckInEmail({
      ...BASE,
      stage: 'check_in_30',
    })
    expect(subject).toBe('Finish moving your Ark+ feed')
    expect(html).toContain('haven&rsquo;t moved')
    expect(html).toContain('early access, ad-free listening, and exclusive content')
    // The escalation belongs to the later stages — this one only mentions the
    // switch-off date as a reason not to put it off.
    expect(html).not.toContain('at risk')
    expect(html.toLowerCase()).not.toContain('final reminder')
  })

  test('names the shows setup unlocks, from the same source as the welcomes', () => {
    // The copy doc's VISUAL BENEFITS LIST. "Every show in the network" is the
    // promise; this is the list that makes it concrete.
    const { html } = renderMigrationCheckInEmail({ ...BASE, stage: 'check_in_30' })
    expect(html).toContain(showRows('https://app.test'))
  })

  test('the later stages do not repeat it', () => {
    // By 60 days the pitch has already failed on this member — those emails
    // escalate to what stops working instead of re-selling the catalogue.
    for (const stage of ['check_in_60', 'final'] as MigrationStage[]) {
      const { html } = renderMigrationCheckInEmail({ ...BASE, stage })
      expect(html).not.toContain(showRows('https://app.test'))
    }
  })
})

describe('60-day check-in', () => {
  test('escalates by naming the three benefits that stop', () => {
    const { subject, html } = renderMigrationCheckInEmail({
      ...BASE,
      stage: 'check_in_60',
    })
    expect(subject).toBe("You're about to lose early access to Call me Back")
    expect(html).toContain('at risk')
    expect(html).toContain('Friday Q&amp;A')
    expect(html).toContain('early access to Wednesday&rsquo;s Call me Back')
    expect(html).toContain('ad-free listening')
    // And still says the membership itself survives the switch.
    expect(html).toContain('Everything else about your membership stays the same')
  })
})

describe('final notice', () => {
  test('counts the days itself rather than trusting the doc literal', () => {
    // A cron that slips a day would otherwise promise five days on the fourth.
    const five = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 5 })
    expect(five.subject).toBe('5 days left to keep your Call me Back benefits')
    expect(five.html).toContain('In 5 days')

    const two = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 2 })
    expect(two.subject).toBe('2 days left to keep your Call me Back benefits')
    expect(two.html).toContain('In 2 days')
  })

  test('singular and same-day read as English, not as "1 days"', () => {
    const one = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 1 })
    expect(one.subject).toBe('1 day left to keep your Call me Back benefits')
    expect(one.html).toContain('Tomorrow, on')

    const today = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 0 })
    expect(today.subject).toBe('Last day to keep your Call me Back benefits')
    expect(today.html).toContain('Today, on')
  })

  test('a negative countdown never renders as negative days', () => {
    const late = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: -3 })
    expect(late.subject).toBe('Last day to keep your Call me Back benefits')
    expect(late.html).not.toContain('-3')
  })

  test('offers the support desk once', () => {
    const { html } = renderMigrationCheckInEmail({ ...BASE, stage: 'final' })
    expect(html.match(new RegExp(`mailto:${SUPPORT_EMAIL}`, 'g')) ?? []).toHaveLength(1)
  })

  test('defuses the expensive misreading: this is not a cancellation', () => {
    // A member who thinks their subscription is ending behaves very differently
    // from one who understands it is a delivery-address change.
    const { html } = renderMigrationCheckInEmail({ ...BASE, stage: 'final' })
    expect(html).toContain('Same price')
    expect(html).toContain('Same billing')
    expect(html).toContain('like changing a mailing address')
  })
})
