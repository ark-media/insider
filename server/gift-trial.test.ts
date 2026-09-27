import { describe, expect, test } from 'bun:test'
import {
  GIFT_TRIAL_MAX_SEC,
  GIFT_TRIAL_MIN_LEAD_SEC,
  giftTrialEndSec,
} from './routes/stripe/gift-trial'

const NOW = 1_800_000_000
const DAY = 24 * 60 * 60
const iso = (sec: number) => new Date(sec * 1000).toISOString()
const row = (ark: number | null, circle: number | null) => ({
  ark_plus_gift_expires_at: ark === null ? null : iso(ark),
  circle_gift_expires_at: circle === null ? null : iso(circle),
})

describe('giftTrialEndSec', () => {
  test('no row, or no gift on the axis → bill today', () => {
    expect(giftTrialEndSec(null, 'ark-plus', NOW)).toBeNull()
    expect(giftTrialEndSec(row(null, null), 'ark-plus', NOW)).toBeNull()
    expect(giftTrialEndSec(row(null, NOW + 90 * DAY), 'ark-plus', NOW)).toBeNull()
  })

  test('single-axis plan covered by its gift → the gift end', () => {
    expect(giftTrialEndSec(row(NOW + 90 * DAY, null), 'ark-plus', NOW)).toBe(NOW + 90 * DAY)
    expect(giftTrialEndSec(row(null, NOW + 30 * DAY), 'circle', NOW)).toBe(NOW + 30 * DAY)
  })

  test('a Bundle gift covers either single tier', () => {
    const both = row(NOW + 90 * DAY, NOW + 90 * DAY)
    expect(giftTrialEndSec(both, 'ark-plus', NOW)).toBe(NOW + 90 * DAY)
    expect(giftTrialEndSec(both, 'circle', NOW)).toBe(NOW + 90 * DAY)
  })

  test('the Bundle needs both axes gifted, and starts billing at the earlier end', () => {
    expect(giftTrialEndSec(row(NOW + 90 * DAY, null), 'bundle', NOW)).toBeNull()
    expect(giftTrialEndSec(row(NOW + 90 * DAY, NOW + 30 * DAY), 'bundle', NOW)).toBe(
      NOW + 30 * DAY,
    )
  })

  test('an expired gift, or one inside the 48-hour floor → bill today', () => {
    expect(giftTrialEndSec(row(NOW - DAY, null), 'ark-plus', NOW)).toBeNull()
    expect(giftTrialEndSec(row(NOW + GIFT_TRIAL_MIN_LEAD_SEC - 1, null), 'ark-plus', NOW)).toBeNull()
    expect(giftTrialEndSec(row(NOW + GIFT_TRIAL_MIN_LEAD_SEC, null), 'ark-plus', NOW)).toBe(
      NOW + GIFT_TRIAL_MIN_LEAD_SEC,
    )
  })

  test('capped at Stripe’s 730-day trial limit', () => {
    expect(giftTrialEndSec(row(NOW + 800 * DAY, null), 'ark-plus', NOW)).toBe(
      NOW + GIFT_TRIAL_MAX_SEC,
    )
  })
})
