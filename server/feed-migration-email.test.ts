// The three migration check-in emails. Pure renderers, so these pin the thing
// that distinguishes them: temperature, and how specific each stage gets about
// what a member is about to lose.

import { describe, test, expect } from 'bun:test'
import { renderMigrationCheckInEmail } from './lib/feed-migration-email'
import { SUPPORT_EMAIL } from './lib/welcome-email'
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
      expect(html).toContain('Podcast app')
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
    expect(subject).toBe('Finish setting up your Ark+ membership')
    expect(html).toContain("haven&rsquo;t finished moving")
    expect(html).toContain('ad-free listening, early access, and exclusive content')
    // The escalation belongs to the later stages — this one only mentions the
    // switch-off date as a reason not to put it off.
    expect(html).not.toContain('at risk')
    expect(html).not.toContain('final reminder')
  })
})

describe('60-day check-in', () => {
  test('escalates by naming the three benefits that stop', () => {
    const { subject, html } = renderMigrationCheckInEmail({
      ...BASE,
      stage: 'check_in_60',
    })
    expect(subject).toBe("You're about to lose early access to Call Me Back")
    expect(html).toContain('at risk')
    expect(html).toContain('Friday Q&amp;A')
    expect(html).toContain('early access to the Wednesday episode')
    expect(html).toContain('ad-free listening')
    // And still says the membership itself survives the switch.
    expect(html).toContain('Everything else about your membership continues')
  })
})

describe('final notice', () => {
  test('counts the days itself rather than trusting the doc literal', () => {
    // A cron that slips a day would otherwise promise five days on the fourth.
    const five = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 5 })
    expect(five.subject).toBe('5 days left to keep your Call Me Back benefits')
    expect(five.html).toContain('In 5 days')

    const two = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 2 })
    expect(two.subject).toBe('2 days left to keep your Call Me Back benefits')
    expect(two.html).toContain('In 2 days')
  })

  test('singular and same-day read as English, not as "1 days"', () => {
    const one = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 1 })
    expect(one.subject).toBe('1 day left to keep your Call Me Back benefits')
    expect(one.html).toContain('Tomorrow, on')

    const today = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: 0 })
    expect(today.subject).toBe('Last day to keep your Call Me Back benefits')
    expect(today.html).toContain('Today, on')
  })

  test('a negative countdown never renders as negative days', () => {
    const late = renderMigrationCheckInEmail({ ...BASE, stage: 'final', daysRemaining: -3 })
    expect(late.subject).toBe('Last day to keep your Call Me Back benefits')
    expect(late.html).not.toContain('-3')
  })

  test('says it once — the urgent support line is not doubled', () => {
    // supportLine() supplies "reach out to us at <address>" itself, so a lead
    // that already said it rendered "reach out to us right away, reach out to
    // us at support@…".
    const { html } = renderMigrationCheckInEmail({ ...BASE, stage: 'final' })
    expect(html.match(/reach out to us/g) ?? []).toHaveLength(1)
    expect(html).toContain('reach out to us right away at')
    // Same for the reassurance — it read twice, once in the body and once in
    // the footer directly beneath it.
    expect(html.match(/already paying for/g) ?? []).toHaveLength(1)
  })

  test('defuses the expensive misreading: this is not a cancellation', () => {
    // A member who thinks their subscription is ending behaves very differently
    // from one who understands it is a delivery-address change.
    const { html } = renderMigrationCheckInEmail({ ...BASE, stage: 'final' })
    expect(html).toContain('subscription and payment aren&rsquo;t affected')
    expect(html).toContain('like changing the address')
  })
})
