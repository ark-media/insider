// Unit tests for the pure Stripe-coupon promo selection logic.

import { describe, test, expect } from 'bun:test'
import {
  isAutoApply,
  appliesToPlan,
  discountCents,
  pickBestCoupon,
  type CouponLike,
} from './lib/stripe-promos'

const coupon = (over: Partial<CouponLike>): CouponLike => ({
  id: 'c',
  valid: true,
  name: null,
  percent_off: null,
  amount_off: null,
  currency: 'usd',
  metadata: {},
  ...over,
})

describe('isAutoApply', () => {
  test('true only when valid and metadata.auto_apply is truthy', () => {
    expect(isAutoApply(coupon({ metadata: { auto_apply: 'true' } }))).toBe(true)
    expect(isAutoApply(coupon({ valid: false, metadata: { auto_apply: 'true' } }))).toBe(false)
    expect(isAutoApply(coupon({ metadata: { auto_apply: 'false' } }))).toBe(false)
    expect(isAutoApply(coupon({ metadata: {} }))).toBe(false)
    expect(isAutoApply(coupon({ metadata: null }))).toBe(false)
  })
  test('is case-insensitive (admins may type "True"/"TRUE")', () => {
    expect(isAutoApply(coupon({ metadata: { auto_apply: 'True' } }))).toBe(true)
    expect(isAutoApply(coupon({ metadata: { auto_apply: 'TRUE' } }))).toBe(true)
  })
})

describe('appliesToPlan', () => {
  test('no plan metadata applies to any plan', () => {
    expect(appliesToPlan(coupon({}), 'monthly')).toBe(true)
    expect(appliesToPlan(coupon({}), 'yearly')).toBe(true)
  })
  test('plan metadata must match', () => {
    const c = coupon({ metadata: { plan: 'yearly' } })
    expect(appliesToPlan(c, 'yearly')).toBe(true)
    expect(appliesToPlan(c, 'monthly')).toBe(false)
  })
})

describe('discountCents', () => {
  test('percent of base', () => {
    expect(discountCents(coupon({ percent_off: 25 }), 8000)).toBe(2000)
  })
  test('fixed amount', () => {
    expect(discountCents(coupon({ amount_off: 500 }), 8000)).toBe(500)
  })
  test('fixed amount is clamped to the base', () => {
    expect(discountCents(coupon({ amount_off: 9000 }), 8000)).toBe(8000)
  })
  test('ignores a fixed amount in a non-USD currency', () => {
    expect(discountCents(coupon({ amount_off: 1000, currency: 'gbp' }), 8000)).toBe(0)
  })
})

describe('pickBestCoupon', () => {
  const auto = (over: Partial<CouponLike>) =>
    coupon({ metadata: { auto_apply: 'true' }, ...over })

  test('returns null when nothing is auto-applicable', () => {
    expect(pickBestCoupon([coupon({ percent_off: 50 })], 'yearly', 8000)).toBeNull()
  })

  test('ranks percent vs fixed by actual discount on the base', () => {
    // On an $80 base: 25% = $20 vs $15 fixed → percent wins.
    const pct = auto({ id: 'pct', percent_off: 25, metadata: { auto_apply: 'true' } })
    const fixed = auto({ id: 'fix', amount_off: 1500, metadata: { auto_apply: 'true' } })
    expect(pickBestCoupon([fixed, pct], 'yearly', 8000)?.id).toBe('pct')
    // On a $40 base: 25% = $10 vs $15 fixed → fixed wins.
    expect(pickBestCoupon([fixed, pct], 'yearly', 4000)?.id).toBe('fix')
  })

  test('ignores invalid, non-auto, and wrong-plan coupons', () => {
    const invalid = auto({ id: 'inv', percent_off: 90, valid: false, metadata: { auto_apply: 'true' } })
    const manual = coupon({ id: 'man', percent_off: 80, metadata: { auto_apply: 'false' } })
    const wrongPlan = auto({ id: 'wp', percent_off: 70, metadata: { auto_apply: 'true', plan: 'monthly' } })
    const ok = auto({ id: 'ok', percent_off: 25, metadata: { auto_apply: 'true', plan: 'yearly' } })
    expect(pickBestCoupon([invalid, manual, wrongPlan, ok], 'yearly', 8000)?.id).toBe('ok')
  })
})
