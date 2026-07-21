// Unit tests for the pure retention-coupon selection logic.

import { describe, test, expect } from 'bun:test'
import {
  couponOfferKind,
  isRetentionCoupon,
  pickOfferCoupon,
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
  test.each<[string, Partial<RetentionCouponLike>, boolean]>([
    ['valid + retention_offer truthy', { metadata: { retention_offer: 'true' } }, true],
    ['invalid coupon is never a retention coupon', { valid: false, metadata: { retention_offer: 'true' } }, false],
    ['retention_offer explicitly false', { metadata: { retention_offer: 'false' } }, false],
    ['no retention_offer key', { metadata: {} }, false],
    ['null metadata', { metadata: null }, false],
    ['case-insensitive: True', { metadata: { retention_offer: 'True' } }, true],
    ['case-insensitive: TRUE', { metadata: { retention_offer: 'TRUE' } }, true],
    ['checkout auto_apply flag is not retention', { metadata: { auto_apply: 'true' } }, false],
  ])('%s', (_label, over, expected) => {
    expect(isRetentionCoupon(coupon(over))).toBe(expected)
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

describe('couponOfferKind', () => {
  test('reads a valid offer_kind from metadata', () => {
    expect(
      couponOfferKind(retention({ metadata: { retention_offer: 'true', offer_kind: 'supporter_coupon' } })),
    ).toBe('supporter_coupon')
  })
  test('null for an unknown or absent offer_kind', () => {
    expect(couponOfferKind(retention({ metadata: { retention_offer: 'true', offer_kind: 'nope' } }))).toBeNull()
    expect(couponOfferKind(retention({}))).toBeNull()
  })
})

describe('pickOfferCoupon', () => {
  const supporter = retention({
    id: 'sup',
    amount_off: 200,
    metadata: { retention_offer: 'true', offer_kind: 'supporter_coupon', plan: 'monthly' },
  })
  const affordability = retention({
    id: 'aff',
    amount_off: 300,
    metadata: { retention_offer: 'true', offer_kind: 'affordability_coupon' },
  })
  const perpetualForever = retention({
    id: 'perp',
    duration: 'forever',
    amount_off: 133,
    metadata: { retention_offer: 'true', offer_kind: 'perpetual_discount', plan: 'monthly' },
  })
  const perpetualBounded = retention({
    id: 'perp-bad',
    duration: 'repeating',
    amount_off: 999,
    metadata: { retention_offer: 'true', offer_kind: 'perpetual_discount' },
  })

  test('matches by offer_kind + plan', () => {
    expect(pickOfferCoupon([supporter, affordability], 'supporter_coupon', 'monthly')?.id).toBe('sup')
    expect(pickOfferCoupon([supporter, affordability], 'affordability_coupon', null)?.id).toBe('aff')
  })
  test('supporter coupon targeted to monthly is not offered to a yearly member', () => {
    expect(pickOfferCoupon([supporter], 'supporter_coupon', 'yearly')).toBeNull()
  })
  test('perpetual_discount requires a duration: forever coupon', () => {
    expect(pickOfferCoupon([perpetualForever], 'perpetual_discount', 'monthly')?.id).toBe('perp')
    expect(pickOfferCoupon([perpetualBounded], 'perpetual_discount', 'monthly')).toBeNull()
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
      kind: 'supporter_coupon',
      couponId: 'save20',
      label: 'Stay 20',
      percentOff: 20,
      amountOff: null,
      durationMonths: 3,
      forever: false,
    })
  })
})
