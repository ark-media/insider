// Unit tests for the pure retention-coupon selection logic.

import { describe, test, expect } from 'bun:test'
import {
  couponOfferKind,
  isRetentionCoupon,
  pickOfferCoupon,
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

// Selection logic, exercised through pickOfferCoupon (the only picker): a
// coupon must be flagged, usable, tagged for the slot, and match the plan.
const sup = (over: Partial<RetentionCouponLike>) =>
  retention({ metadata: { retention_offer: 'true', offer_kind: 'supporter_coupon' }, ...over })

describe('pickOfferCoupon selection', () => {
  test('null when nothing is flagged for retention', () => {
    const untagged = coupon({ percent_off: 50, metadata: { offer_kind: 'supporter_coupon' } })
    expect(pickOfferCoupon([untagged], 'supporter_coupon')).toBeNull()
  })

  test('null when flagged for retention but tagged for no slot', () => {
    expect(pickOfferCoupon([retention({ percent_off: 50 })], 'supporter_coupon')).toBeNull()
  })

  test('prefers the largest percent_off', () => {
    const small = sup({ id: 'small', percent_off: 10 })
    const big = sup({ id: 'big', percent_off: 30 })
    expect(pickOfferCoupon([small, big], 'supporter_coupon')?.id).toBe('big')
  })

  test('falls back to the largest USD amount_off when no percent coupon is tagged', () => {
    const a = sup({ id: 'a', amount_off: 300 })
    const b = sup({ id: 'b', amount_off: 700 })
    expect(pickOfferCoupon([a, b], 'supporter_coupon')?.id).toBe('b')
  })

  test('a percent coupon wins over a fixed one regardless of order', () => {
    const fixed = sup({ id: 'fix', amount_off: 9999 })
    const pct = sup({ id: 'pct', percent_off: 5 })
    expect(pickOfferCoupon([fixed, pct], 'supporter_coupon')?.id).toBe('pct')
    expect(pickOfferCoupon([pct, fixed], 'supporter_coupon')?.id).toBe('pct')
  })

  test('ignores invalid coupons and non-USD fixed amounts', () => {
    const invalid = sup({ id: 'inv', percent_off: 90, valid: false })
    const foreign = sup({ id: 'gbp', amount_off: 1000, currency: 'gbp' })
    const ok = sup({ id: 'ok', percent_off: 20 })
    expect(pickOfferCoupon([invalid, foreign, ok], 'supporter_coupon')?.id).toBe('ok')
  })

  test('a coupon with neither percent nor amount is not usable', () => {
    expect(pickOfferCoupon([sup({})], 'supporter_coupon')).toBeNull()
  })
})

describe('pickOfferCoupon plan targeting', () => {
  const kind = { retention_offer: 'true', offer_kind: 'supporter_coupon' }
  const monthlyOnly = retention({ id: 'm', percent_off: 40, metadata: { ...kind, plan: 'monthly' } })
  const yearlyOnly = retention({ id: 'y', percent_off: 30, metadata: { ...kind, plan: 'yearly' } })
  const both = retention({ id: 'b', percent_off: 10, metadata: kind })

  test('offers a plan-targeted coupon only to that plan', () => {
    expect(pickOfferCoupon([monthlyOnly], 'supporter_coupon', 'monthly')?.id).toBe('m')
    expect(pickOfferCoupon([monthlyOnly], 'supporter_coupon', 'yearly')).toBeNull()
    expect(pickOfferCoupon([yearlyOnly], 'supporter_coupon', 'yearly')?.id).toBe('y')
    expect(pickOfferCoupon([yearlyOnly], 'supporter_coupon', 'monthly')).toBeNull()
  })

  test('picks the best among the coupons that match the plan', () => {
    const all = [monthlyOnly, yearlyOnly, both]
    // monthly member sees monthly-only (40) over the both-plans 10
    expect(pickOfferCoupon(all, 'supporter_coupon', 'monthly')?.id).toBe('m')
    // yearly member sees yearly-only (30) over the both-plans 10
    expect(pickOfferCoupon(all, 'supporter_coupon', 'yearly')?.id).toBe('y')
  })

  test('an untargeted ("both") coupon applies to either plan', () => {
    expect(pickOfferCoupon([both], 'supporter_coupon', 'monthly')?.id).toBe('b')
    expect(pickOfferCoupon([both], 'supporter_coupon', 'yearly')?.id).toBe('b')
  })

  test('unknown plan (null) offers only untargeted coupons', () => {
    expect(pickOfferCoupon([monthlyOnly, yearlyOnly], 'supporter_coupon', null)).toBeNull()
    expect(pickOfferCoupon([monthlyOnly, both], 'supporter_coupon', null)?.id).toBe('b')
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
  test('matches by offer_kind + plan', () => {
    expect(pickOfferCoupon([supporter, affordability], 'supporter_coupon', 'monthly')?.id).toBe('sup')
    expect(pickOfferCoupon([supporter, affordability], 'affordability_coupon', null)?.id).toBe('aff')
  })
  test('supporter coupon targeted to monthly is not offered to a yearly member', () => {
    expect(pickOfferCoupon([supporter], 'supporter_coupon', 'yearly')).toBeNull()
  })
  test('a coupon tagged for another slot is never served', () => {
    expect(pickOfferCoupon([supporter], 'affordability_coupon', 'monthly')).toBeNull()
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
    })
  })
})
