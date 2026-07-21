// Unit tests for the rolling 12-month retention-coupon eligibility window
// (Decision #6): a promotional coupon accept blocks a new coupon offer for 12
// months; plan switches are never rate-limited.

import { describe, test, expect } from 'bun:test'
import {
  RETENTION_WINDOW_MONTHS,
  offerBlockedByWindow,
  withinRetentionWindow,
} from './lib/cancellation'

// A fixed "now" so the test never depends on the wall clock.
const NOW = new Date('2026-07-21T00:00:00.000Z')
const monthsBefore = (n: number) => {
  const d = new Date(NOW)
  d.setMonth(d.getMonth() - n)
  return d
}

describe('withinRetentionWindow', () => {
  test('never accepted is always outside the window', () => {
    expect(withinRetentionWindow(null, NOW)).toBe(false)
  })
  test('an accept 11 months ago is still inside the window', () => {
    expect(withinRetentionWindow(monthsBefore(11), NOW)).toBe(true)
  })
  test('an accept 13 months ago is outside the window', () => {
    expect(withinRetentionWindow(monthsBefore(13), NOW)).toBe(false)
  })
  test(`window is ${RETENTION_WINDOW_MONTHS} months`, () => {
    expect(RETENTION_WINDOW_MONTHS).toBe(12)
  })
})

describe('offerBlockedByWindow (coupon accepted at T)', () => {
  const acceptedAtT = monthsBefore(0)

  test('a coupon is blocked at T+11mo and eligible again at T+13mo', () => {
    // Evaluated 11 months after the accept: still blocked.
    const at11 = new Date(acceptedAtT)
    at11.setMonth(at11.getMonth() + 11)
    expect(offerBlockedByWindow('supporter_coupon', acceptedAtT, at11)).toBe(true)
    expect(offerBlockedByWindow('affordability_coupon', acceptedAtT, at11)).toBe(true)

    // Evaluated 13 months after the accept: eligible again.
    const at13 = new Date(acceptedAtT)
    at13.setMonth(at13.getMonth() + 13)
    expect(offerBlockedByWindow('supporter_coupon', acceptedAtT, at13)).toBe(false)
  })

  test('plan switches are allowed at any T, regardless of a recent coupon accept', () => {
    expect(offerBlockedByWindow('annual_switch', acceptedAtT, NOW)).toBe(false)
    expect(offerBlockedByWindow('monthly_switch', acceptedAtT, NOW)).toBe(false)
    // Even with an accept one month ago (deep inside the window).
    expect(offerBlockedByWindow('annual_switch', monthsBefore(1), NOW)).toBe(false)
    expect(offerBlockedByWindow('monthly_switch', monthsBefore(1), NOW)).toBe(false)
  })

  test('a never-accepted member is not blocked for any offer kind', () => {
    expect(offerBlockedByWindow('supporter_coupon', null, NOW)).toBe(false)
    expect(offerBlockedByWindow('annual_switch', null, NOW)).toBe(false)
  })
})
