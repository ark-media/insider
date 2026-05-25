// Unit tests for the pure promo builder + serializer.

import { describe, test, expect } from 'bun:test'
import type Stripe from 'stripe'
import { buildPromo, serializeCoupon } from './admin-promos'

// Coupon metadata is typed `"" | MetadataParam`; in these tests we always set
// it to a record, so narrow it for readable assertions.
const meta = (m: unknown): Record<string, string> => m as Record<string, string>

describe('buildPromo', () => {
  test('rejects non-objects and unknown discount types', () => {
    expect(buildPromo(null).ok).toBe(false)
    expect(buildPromo({ discountType: 'nope' }).ok).toBe(false)
  })

  test('percent discount with bounds', () => {
    const r = buildPromo({ discountType: 'percent', percentOff: 25, duration: 'once', autoApply: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.coupon.percent_off).toBe(25)
      expect(meta(r.value.coupon.metadata).auto_apply).toBe('true')
    }
    expect(buildPromo({ discountType: 'percent', percentOff: 0, duration: 'once' }).ok).toBe(false)
    expect(buildPromo({ discountType: 'percent', percentOff: 101, duration: 'once' }).ok).toBe(false)
  })

  test('amount discount is USD cents', () => {
    const r = buildPromo({ discountType: 'amount', amountOffCents: 600, duration: 'forever' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.coupon.amount_off).toBe(600)
      expect(r.value.coupon.currency).toBe('usd')
    }
    expect(buildPromo({ discountType: 'amount', amountOffCents: 0, duration: 'once' }).ok).toBe(false)
    expect(buildPromo({ discountType: 'amount', amountOffCents: 1.5, duration: 'once' }).ok).toBe(false)
  })

  test('repeating duration requires months', () => {
    expect(buildPromo({ discountType: 'percent', percentOff: 10, duration: 'repeating' }).ok).toBe(false)
    const r = buildPromo({ discountType: 'percent', percentOff: 10, duration: 'repeating', durationInMonths: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.coupon.duration_in_months).toBe(3)
  })

  test('plan targeting via metadata', () => {
    const both = buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once' })
    if (both.ok) expect(meta(both.value.coupon.metadata).plan).toBeUndefined()
    const yearly = buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', plan: 'yearly' })
    if (yearly.ok) expect(meta(yearly.value.coupon.metadata).plan).toBe('yearly')
    expect(buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', plan: 'weekly' }).ok).toBe(false)
  })

  test('auto_apply defaults to false', () => {
    const r = buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once' })
    if (r.ok) expect(meta(r.value.coupon.metadata).auto_apply).toBe('false')
  })

  test('code is validated and upper-cased', () => {
    const r = buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', code: 'spring60' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.code).toBe('SPRING60')
    expect(buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', code: 'has spaces' }).ok).toBe(false)
  })

  test('redeemBy must be a future date and becomes unix seconds', () => {
    expect(buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', redeemBy: '2000-01-01' }).ok).toBe(false)
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const r = buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', redeemBy: future })
    if (r.ok) expect(r.value.coupon.redeem_by).toBe(Math.floor(Date.parse(future) / 1000))
  })

  test('maxRedemptions must be a positive integer', () => {
    expect(buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', maxRedemptions: 0 }).ok).toBe(false)
    const r = buildPromo({ discountType: 'percent', percentOff: 10, duration: 'once', maxRedemptions: 50 })
    if (r.ok) expect(r.value.coupon.max_redemptions).toBe(50)
  })
})

describe('serializeCoupon', () => {
  test('flattens metadata flags and normalizes redeem_by', () => {
    const coupon = {
      id: 'co_1',
      name: 'Spring',
      valid: true,
      percent_off: 20,
      amount_off: null,
      currency: null,
      duration: 'once',
      duration_in_months: null,
      metadata: { auto_apply: 'true', plan: 'yearly' },
      max_redemptions: 100,
      times_redeemed: 5,
      redeem_by: 1_800_000_000,
    } as unknown as Stripe.Coupon

    const v = serializeCoupon(coupon, 'SPRING60')
    expect(v).toMatchObject({
      id: 'co_1',
      kind: 'percent',
      percentOff: 20,
      autoApply: true,
      plan: 'yearly',
      maxRedemptions: 100,
      timesRedeemed: 5,
      code: 'SPRING60',
    })
    expect(v.redeemBy).toBe(new Date(1_800_000_000 * 1000).toISOString())
  })
})
