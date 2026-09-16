// Unit tests for debundle pricing: what a single product costs once a bundle is
// split. It is that product's OWN standalone catalog price — the bundle is a
// discount on two standalone prices, and splitting it forfeits that — softened
// by a bounded `debundle_intro` coupon for a fixed term. Both figures resolve
// from Stripe; nothing here is hardcoded in app code.
//
// Per scripts/stripe-catalog.ts the singles are $8/mo (800) and $80/yr (8000)
// and the bundle is $13/mo (1300) and $130/yr (13000). An 18.75% intro coupon
// lands those on $6.50 and $65 — half the bundle, the rate the member paid for
// each component inside it.

import { describe, test, expect } from 'bun:test'
import type Stripe from 'stripe'
import { getPlanPriceCents, SUPPORTED_CURRENCIES } from './lib/pricing'
import {
  bundleBreakdown,
  debundlePricePreview,
  discountedCents,
  pickIntroCoupon,
  type RetentionCouponLike,
} from './lib/retention'

const coupon = (over: Partial<RetentionCouponLike>): RetentionCouponLike => ({
  id: 'c',
  valid: true,
  name: null,
  percent_off: null,
  amount_off: null,
  currency: 'usd',
  duration: 'repeating',
  duration_in_months: 6,
  metadata: { retention_offer: 'true', offer_kind: 'debundle_intro' },
  ...over,
})

// The seeded intro: 18.75% off a standalone price is exactly half the bundle.
const intro = coupon({ id: 'debundle_intro_6mo', percent_off: 18.75 })

// Minimal Stripe stub: prices.list for the catalog, coupons.list for the intro.
// Bundle is priced above the single products so a preview that wrongly read the
// bundle would show a different number and fail. (resolveCatalogPrice caches per
// lookup key for the life of the process, so a sibling suite may serve a cached
// amount from ITS mock — the async assertions below therefore state the RULE
// against a re-resolved price rather than a literal. Literals live in the pure
// discountedCents tests.)
function fakeStripe(coupons: RetentionCouponLike[] = [intro]): Stripe {
  return {
    coupons: {
      list: async () => ({ data: coupons, has_more: false }),
    },
    prices: {
      list: async (args: { lookup_keys?: string[] }) => {
        const key = args.lookup_keys?.[0] ?? ''
        const single = key.includes('monthly') ? 800 : 8000
        const bundle = key.includes('monthly') ? 1300 : 13000
        const base = key.startsWith('bundle') ? bundle : single
        const currency_options: Record<string, { unit_amount: number }> = {}
        for (const cur of SUPPORTED_CURRENCIES) {
          if (cur !== 'usd') currency_options[cur] = { unit_amount: base }
        }
        return {
          data: [
            {
              id: `price_${key}`,
              product: `prod_${key}`,
              unit_amount: base,
              currency: 'usd',
              currency_options,
            },
          ],
        }
      },
    },
  } as unknown as Stripe
}

describe('discountedCents', () => {
  test('the seeded intro puts a standalone price at half the bundle', () => {
    expect(discountedCents(800, 18.75, null)).toBe(650) //  $8/mo  → $6.50/mo
    expect(discountedCents(8000, 18.75, null)).toBe(6500) // $80/yr → $65/yr
  })

  test('subtracts a fixed amount and never goes below zero', () => {
    expect(discountedCents(800, null, 150)).toBe(650)
    expect(discountedCents(800, null, 90_000)).toBe(0)
  })

  test('is null when the coupon carries no discount at all', () => {
    expect(discountedCents(800, null, null)).toBeNull()
  })
})

describe('pickIntroCoupon', () => {
  test('picks the debundle_intro slot', () => {
    expect(pickIntroCoupon([intro])?.id).toBe('debundle_intro_6mo')
  })

  test('ignores coupons in another save slot', () => {
    const supporter = coupon({
      id: 'sup',
      percent_off: 50,
      metadata: { retention_offer: 'true', offer_kind: 'supporter_coupon' },
    })
    expect(pickIntroCoupon([supporter])).toBeNull()
  })

  test('ignores an untagged or invalid coupon', () => {
    const untagged = coupon({ id: 'u', percent_off: 20, metadata: { retention_offer: 'true' } })
    const expired = coupon({ id: 'x', percent_off: 20, valid: false })
    expect(pickIntroCoupon([untagged, expired])).toBeNull()
  })

  test('is null when nothing is configured', () => {
    expect(pickIntroCoupon([])).toBeNull()
  })
})

describe('debundlePricePreview', () => {
  test("quotes the kept product's own standalone price, not the bundle", async () => {
    const stripe = fakeStripe()
    const preview = await debundlePricePreview(stripe, 'circle', 'monthly')
    const standalone = await getPlanPriceCents(stripe, 'circle', 'monthly')
    expect(preview.tier).toBe('circle')
    expect(preview.plan).toBe('monthly')
    expect(preview.priceCents).toBe(standalone)
    // The intro is derived by applying the live coupon, so the quote can't drift
    // from what Stripe will charge.
    expect(preview.introCents).toBe(discountedCents(standalone, 18.75, null))
    expect(preview.introMonths).toBe(6)
  })

  test('resolves the yearly standalone price + intro', async () => {
    const stripe = fakeStripe()
    const preview = await debundlePricePreview(stripe, 'ark-plus', 'yearly')
    const standalone = await getPlanPriceCents(stripe, 'ark-plus', 'yearly')
    expect(preview.priceCents).toBe(standalone)
    expect(preview.introCents).toBe(discountedCents(standalone, 18.75, null))
  })

  test('lands at the standalone price when no intro coupon is configured', async () => {
    const stripe = fakeStripe([])
    const preview = await debundlePricePreview(stripe, 'circle', 'monthly')
    expect(preview.priceCents).toBe(await getPlanPriceCents(stripe, 'circle', 'monthly'))
    expect(preview.introCents).toBeNull()
    expect(preview.introMonths).toBeNull()
  })

  test('drops an intro that would not actually reduce the price', async () => {
    // A 0%-off coupon is configured but inert — show the plain price rather than
    // a struck-through pair with two identical figures.
    const stripe = fakeStripe([coupon({ percent_off: 0 })])
    const preview = await debundlePricePreview(stripe, 'circle', 'monthly')
    expect(preview.introCents).toBeNull()
    expect(preview.introMonths).toBeNull()
  })
})

describe('bundleBreakdown', () => {
  test('each row is that product standalone, with its intro rate', async () => {
    const stripe = fakeStripe()
    const b = await bundleBreakdown(stripe, 'yearly')
    expect(b.plan).toBe('yearly')
    expect(b.arkPlus.priceCents).toBe(await getPlanPriceCents(stripe, 'ark-plus', 'yearly'))
    expect(b.circle.priceCents).toBe(await getPlanPriceCents(stripe, 'circle', 'yearly'))
    expect(b.bundleCents).toBe(await getPlanPriceCents(stripe, 'bundle', 'yearly'))
    expect(b.arkPlus.introCents).toBe(discountedCents(b.arkPlus.priceCents, 18.75, null))
  })

  test('the two rows do NOT sum to the bundle — that gap is the discount', async () => {
    const b = await bundleBreakdown(fakeStripe(), 'monthly')
    expect(b.arkPlus.priceCents + b.circle.priceCents).not.toBe(b.bundleCents)
    // …and the bundle undercuts buying both, which is what makes it a bundle.
    expect(b.bundleCents).toBeLessThan(b.arkPlus.priceCents + b.circle.priceCents)
  })
})
