// Unit tests for the pure Stripe-coupon promo selection logic.

import { describe, test, expect } from 'bun:test'
import {
  isAutoApply,
  appliesToPlan,
  discountCents,
  pickAutoApplyPromo,
  pickBestCoupon,
  redeemableCodeByCoupon,
  type CouponLike,
  type PromotionCodeLike,
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

// A promotion code as Stripe returns it: the string a buyer types, plus the
// coupon it stands for.
const promoCode = (over: Partial<PromotionCodeLike>): PromotionCodeLike => ({
  code: 'SPRING60',
  active: true,
  customer: null,
  promotion: { coupon: 'c' },
  ...over,
})

describe('redeemableCodeByCoupon', () => {
  test('maps a coupon to the code that applies it', () => {
    const map = redeemableCodeByCoupon([
      promoCode({ code: 'SPRING60', promotion: { coupon: 'c1' } }),
    ])
    expect(map.get('c1')).toBe('SPRING60')
  })

  test('accepts an expanded coupon object, not just an id', () => {
    const map = redeemableCodeByCoupon([
      promoCode({ code: 'EXPANDED', promotion: { coupon: { id: 'c1' } } }),
    ])
    expect(map.get('c1')).toBe('EXPANDED')
  })

  test('skips codes nobody could redeem', () => {
    const map = redeemableCodeByCoupon([
      // Stripe rejects an inactive code at redemption.
      promoCode({ code: 'DEAD', active: false, promotion: { coupon: 'c1' } }),
      // Reserved for one customer: handing it to every buyer would leak it, and
      // it would fail for all of them but one.
      promoCode({ code: 'VIP', customer: 'cus_1', promotion: { coupon: 'c2' } }),
      promoCode({ code: 'ORPHAN', promotion: { coupon: null } }),
    ])
    expect(map.size).toBe(0)
  })

  test('first code wins when a coupon has several', () => {
    const map = redeemableCodeByCoupon([
      promoCode({ code: 'FIRST', promotion: { coupon: 'c1' } }),
      promoCode({ code: 'SECOND', promotion: { coupon: 'c1' } }),
    ])
    expect(map.get('c1')).toBe('FIRST')
  })
})

describe('pickAutoApplyPromo', () => {
  const autoApply = (id: string, percentOff: number): CouponLike =>
    coupon({ id, percent_off: percentOff, metadata: { auto_apply: 'true' } })

  test('returns the winning coupon with the code that applies it', () => {
    const best = pickAutoApplyPromo(
      [autoApply('c1', 10), autoApply('c2', 30)],
      [
        promoCode({ code: 'TEN', promotion: { coupon: 'c1' } }),
        promoCode({ code: 'THIRTY', promotion: { coupon: 'c2' } }),
      ],
      'monthly',
      1000,
    )
    expect(best).toEqual({ coupon: autoApply('c2', 30), code: 'THIRTY' })
  })

  test('a codeless coupon is unreachable, so the best CODED one wins', () => {
    // Checkout applies the sale with the buyer's own applyPromotionCode call,
    // so a bigger discount with no code to type is not an option at all.
    const best = pickAutoApplyPromo(
      [autoApply('c1', 50), autoApply('c2', 20)],
      [promoCode({ code: 'TWENTY', promotion: { coupon: 'c2' } })],
      'monthly',
      1000,
    )
    expect(best?.code).toBe('TWENTY')
  })

  test('null when no auto-apply coupon has a redeemable code', () => {
    expect(
      pickAutoApplyPromo(
        [autoApply('c1', 50)],
        [promoCode({ code: 'DEAD', active: false, promotion: { coupon: 'c1' } })],
        'monthly',
        1000,
      ),
    ).toBeNull()
  })

  test('still respects plan targeting and the charge currency', () => {
    const yearlyOnly = coupon({
      id: 'c1',
      percent_off: 40,
      metadata: { auto_apply: 'true', plan: 'yearly' },
    })
    const eurOff = coupon({
      id: 'c2',
      amount_off: 500,
      currency: 'eur',
      metadata: { auto_apply: 'true' },
    })
    const codes = [
      promoCode({ code: 'YEARLY', promotion: { coupon: 'c1' } }),
      promoCode({ code: 'EUR', promotion: { coupon: 'c2' } }),
    ]
    // Wrong plan, and a fixed EUR discount Stripe would reject on a USD charge.
    expect(pickAutoApplyPromo([yearlyOnly, eurOff], codes, 'monthly', 1000)).toBeNull()
    expect(pickAutoApplyPromo([yearlyOnly, eurOff], codes, 'yearly', 1000)?.code).toBe('YEARLY')
    // A gift passes plan=null: targeting is ignored, so the yearly coupon applies.
    expect(pickAutoApplyPromo([yearlyOnly, eurOff], codes, null, 1000)?.code).toBe('YEARLY')
  })
})
