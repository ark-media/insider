// Unit tests for the pure retention-coupon selection logic.

import { describe, test, expect } from 'bun:test'
import {
  isRetentionCoupon,
  pickRetentionCoupon,
  toRetentionOffer,
  type RetentionCouponLike,
} from './lib/retention'

const coupon = (over: Partial<RetentionCouponLike>): RetentionCouponLike => ({
  id: 'c',
  valid: true,
  name: null,
  percent_off: null,
  amount_off: null,
  currency: 'usd',
  duration_in_months: null,
  metadata: {},
  ...over,
})

const retention = (over: Partial<RetentionCouponLike>) =>
  coupon({ metadata: { retention_offer: 'true' }, ...over })

describe('isRetentionCoupon', () => {
  test('true only when valid and metadata.retention_offer is truthy', () => {
    expect(isRetentionCoupon(coupon({ metadata: { retention_offer: 'true' } }))).toBe(true)
    expect(
      isRetentionCoupon(coupon({ valid: false, metadata: { retention_offer: 'true' } })),
    ).toBe(false)
    expect(isRetentionCoupon(coupon({ metadata: { retention_offer: 'false' } }))).toBe(false)
    expect(isRetentionCoupon(coupon({ metadata: {} }))).toBe(false)
    expect(isRetentionCoupon(coupon({ metadata: null }))).toBe(false)
  })
  test('is case-insensitive', () => {
    expect(isRetentionCoupon(coupon({ metadata: { retention_offer: 'True' } }))).toBe(true)
    expect(isRetentionCoupon(coupon({ metadata: { retention_offer: 'TRUE' } }))).toBe(true)
  })
  test('checkout auto_apply flag does not make a retention coupon', () => {
    expect(isRetentionCoupon(coupon({ metadata: { auto_apply: 'true' } }))).toBe(false)
  })
})

describe('pickRetentionCoupon', () => {
  test('null when nothing is flagged', () => {
    expect(pickRetentionCoupon([coupon({ percent_off: 50 })])).toBeNull()
  })

  test('prefers the largest percent_off', () => {
    const small = retention({ id: 'small', percent_off: 10 })
    const big = retention({ id: 'big', percent_off: 30 })
    expect(pickRetentionCoupon([small, big])?.id).toBe('big')
  })

  test('falls back to the largest USD amount_off when no percent coupon is flagged', () => {
    const a = retention({ id: 'a', amount_off: 300 })
    const b = retention({ id: 'b', amount_off: 700 })
    expect(pickRetentionCoupon([a, b])?.id).toBe('b')
  })

  test('a percent coupon wins over a fixed one regardless of order', () => {
    const fixed = retention({ id: 'fix', amount_off: 9999 })
    const pct = retention({ id: 'pct', percent_off: 5 })
    expect(pickRetentionCoupon([fixed, pct])?.id).toBe('pct')
    expect(pickRetentionCoupon([pct, fixed])?.id).toBe('pct')
  })

  test('ignores invalid coupons and non-USD fixed amounts', () => {
    const invalid = retention({ id: 'inv', percent_off: 90, valid: false })
    const foreign = retention({ id: 'gbp', amount_off: 1000, currency: 'gbp' })
    const ok = retention({ id: 'ok', percent_off: 20 })
    expect(pickRetentionCoupon([invalid, foreign, ok])?.id).toBe('ok')
  })

  test('a coupon with neither percent nor amount is not usable', () => {
    expect(pickRetentionCoupon([retention({ percent_off: null, amount_off: null })])).toBeNull()
  })
})

describe('pickRetentionCoupon plan targeting', () => {
  const monthlyOnly = retention({ id: 'm', percent_off: 40, metadata: { retention_offer: 'true', plan: 'monthly' } })
  const yearlyOnly = retention({ id: 'y', percent_off: 30, metadata: { retention_offer: 'true', plan: 'yearly' } })
  const both = retention({ id: 'b', percent_off: 10 })

  test('offers a plan-targeted coupon only to that plan', () => {
    expect(pickRetentionCoupon([monthlyOnly], 'monthly')?.id).toBe('m')
    expect(pickRetentionCoupon([monthlyOnly], 'yearly')).toBeNull()
    expect(pickRetentionCoupon([yearlyOnly], 'yearly')?.id).toBe('y')
    expect(pickRetentionCoupon([yearlyOnly], 'monthly')).toBeNull()
  })

  test('picks the best among the coupons that match the plan', () => {
    const all = [monthlyOnly, yearlyOnly, both]
    // monthly member sees monthly-only (40) over the both-plans 10
    expect(pickRetentionCoupon(all, 'monthly')?.id).toBe('m')
    // yearly member sees yearly-only (30) over the both-plans 10
    expect(pickRetentionCoupon(all, 'yearly')?.id).toBe('y')
  })

  test('an untargeted ("both") coupon applies to either plan', () => {
    expect(pickRetentionCoupon([both], 'monthly')?.id).toBe('b')
    expect(pickRetentionCoupon([both], 'yearly')?.id).toBe('b')
  })

  test('unknown plan (null) offers only untargeted coupons', () => {
    expect(pickRetentionCoupon([monthlyOnly, yearlyOnly], null)).toBeNull()
    expect(pickRetentionCoupon([monthlyOnly, both], null)?.id).toBe('b')
  })
})

describe('toRetentionOffer', () => {
  test('flattens the coupon into the client DTO', () => {
    const c = retention({
      id: 'save20',
      name: 'Stay 20',
      percent_off: 20,
      duration_in_months: 3,
    })
    expect(toRetentionOffer(c)).toEqual({
      couponId: 'save20',
      label: 'Stay 20',
      percentOff: 20,
      amountOff: null,
      durationMonths: 3,
    })
  })
})
