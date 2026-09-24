// The sentences a member reads about a change to what they pay. These exist as
// a shared module because the confirm panel and the follow-up email describe
// the SAME event minutes apart, and the wording has to stay identical.

import { describe, expect, test } from 'bun:test'
import { dueTodayLine, perPeriod, renewsLine, SETTLED_TODAY } from './billing-copy'

test('a price is quoted in the member’s own billing period', () => {
  expect(perPeriod('monthly')).toBe('a month')
  expect(perPeriod('yearly')).toBe('a year')
})

describe('dueTodayLine', () => {
  test('names the figure that comes off the card today', () => {
    expect(dueTodayLine({ amount: '£172.40' })).toBe(
      "You pay £172.40 today: the new price, less credit for what's left of your current plan.",
    )
  })

  test('a member whose unused time covers the new price is told nothing is due', () => {
    const line = dueTodayLine('nothing')
    expect(line.startsWith('Nothing to pay today')).toBe(true)
  })

  test('without a quote it still says the charge is today, with no made-up figure', () => {
    const line = dueTodayLine('unknown')
    expect(line).toContain('today')
    expect(line).not.toMatch(/[$£€]/)
  })
})

describe('renewsLine', () => {
  test('the date is placed, not appended', () => {
    expect(renewsLine({ plan: 'yearly', renewsOn: 'September 24, 2027' })).toBe(
      'Your membership then renews on September 24, 2027.',
    )
  })

  test('an unreadable date falls back to the cadence, not to "null"', () => {
    expect(renewsLine({ plan: 'yearly', renewsOn: null })).toBe(
      'Your membership then renews a year from today.',
    )
    expect(renewsLine({ plan: 'monthly', renewsOn: null })).toBe(
      'Your membership then renews a month from today.',
    )
  })
})

test('none of it speaks our billing vocabulary', () => {
  const all = [
    dueTodayLine({ amount: '$17' }),
    dueTodayLine('nothing'),
    dueTodayLine('unknown'),
    renewsLine({ plan: 'monthly', renewsOn: null }),
    SETTLED_TODAY,
  ].join(' ').toLowerCase()
  for (const jargon of ['prorat', 'invoice', 'billing period', 'next bill']) {
    expect(all).not.toContain(jargon)
  }
})
