// The sentences a member reads about a change to what they pay. These exist as
// a shared module because the confirm panel and the follow-up email describe
// the SAME event minutes apart, and each used to carry its own copy of this
// wording — which drifted: the success banner hardcoded the monthly phrasing
// and the charge direction, contradicting the panel the member had just read.

import { describe, expect, test } from 'bun:test'
import { nextBillLine, perPeriod, restOfPeriod, NOTHING_TO_PAY_TODAY } from './billing-copy'

describe('cadence', () => {
  test('a price is quoted in the member’s own billing period', () => {
    expect(perPeriod('monthly')).toBe('a month')
    expect(perPeriod('yearly')).toBe('a year')
  })

  test('so is the remainder of the period the change settles over', () => {
    expect(restOfPeriod('monthly')).toBe('the rest of this month')
    expect(restOfPeriod('yearly')).toBe('the rest of this year')
  })
})

describe('nextBillLine', () => {
  test('a yearly member is never told about a month', () => {
    const line = nextBillLine({ plan: 'yearly', renewsOn: 'March 1, 2027', settlement: 'charged' })
    expect(line).toContain('the rest of this year')
    expect(line).not.toContain('month')
  })

  test('a member who was paying MORE is owed credit, not charged a difference', () => {
    const line = nextBillLine({ plan: 'monthly', renewsOn: 'March 1, 2027', settlement: 'credited' })
    expect(line).toContain("credit for what you've already paid")
    expect(line).not.toContain('difference')
  })

  test("'unknown' takes the phrasing that is true whichever way the money went", () => {
    // What the email renderer gets: it is told the new price, never the old one.
    const line = nextBillLine({ plan: 'monthly', renewsOn: 'March 1, 2027', settlement: 'unknown' })
    expect(line).toContain('at the new price')
    expect(line).not.toContain('difference')
    expect(line).not.toContain('credit')
  })

  test('an unreadable date drops the date, not the sentence', () => {
    // Glued from clauses this ran together into "Your next bill with the
    // difference…", which is why each variant is written whole.
    for (const settlement of ['charged', 'credited', 'unknown'] as const) {
      const line = nextBillLine({ plan: 'monthly', renewsOn: null, settlement })
      expect(line.startsWith('Your next bill')).toBe(true)
      expect(line.endsWith('.')).toBe(true)
      expect(line).not.toContain('null')
      expect(line).not.toContain('undefined')
    }
  })

  test('the date is placed, not appended', () => {
    expect(
      nextBillLine({ plan: 'monthly', renewsOn: 'March 1, 2027', settlement: 'charged' }),
    ).toBe('Your next bill is March 1, 2027, with the difference for the rest of this month added on.')
  })
})

test('the answer to "what comes off my card today" is stated out loud', () => {
  // Nobody guesses "nothing" — the change settles on the next bill instead, so
  // a member watching their card sees no charge and no explanation unless the
  // copy gives them one.
  expect(NOTHING_TO_PAY_TODAY).toBe('Nothing to pay today.')
})
