// The ICMB welcome offer's decision core — the parts that decide money and
// eligibility without Stripe or a database in the way.
//
// The pricing assertions are the point of this file: the offer is quoted as
// fixed prices ($200/yr, $20/mo) but the coupons are minted for 40 currencies
// by scaling the catalog's Bundle price, so what is pinned here is that the
// scaling reproduces the quoted USD figures exactly and stays chargeable in
// the currencies Stripe is fussy about.

import { describe, test, expect } from 'bun:test'
import {
  blockFor,
  offerAmountFor,
  redeemIdempotencyKey,
  welcomeDiscountActive,
  WELCOME_OFFER_COHORT,
  WELCOME_OFFER_ELIGIBLE_BEFORE_ISO,
  WELCOME_OFFER_REDEEM_BY_ISO,
  WELCOME_OFFER_USD_MINOR,
} from './welcome-offer'

// A slice of the catalog's Bundle floors, as resolveCatalogPrice returns them.
// USD/EUR/CHF are ordinary 2-decimal currencies; JPY is zero-decimal; HUF and
// TWD must come out as whole major units (an exact multiple of 100 minor).
const BUNDLE_YEARLY = { usd: 25_000, eur: 28_125, chf: 21_875, jpy: 40_625, huf: 10_906_300, twd: 906_300 }
const BUNDLE_MONTHLY = { usd: 2_500, eur: 2_813, chf: 2_188, jpy: 4_063, huf: 1_090_600, twd: 90_600 }

describe('offerAmountFor', () => {
  test('lands exactly on the quoted USD prices', () => {
    expect(offerAmountFor(BUNDLE_YEARLY, 'yearly', 'usd')).toEqual({
      bundleMinor: 25_000,
      offerMinor: WELCOME_OFFER_USD_MINOR.yearly,
      discountMinor: 5_000,
    })
    expect(offerAmountFor(BUNDLE_MONTHLY, 'monthly', 'usd')).toEqual({
      bundleMinor: 2_500,
      offerMinor: WELCOME_OFFER_USD_MINOR.monthly,
      discountMinor: 500,
    })
  })

  test('scales other currencies off their own Bundle price', () => {
    expect(offerAmountFor(BUNDLE_YEARLY, 'yearly', 'eur').offerMinor).toBe(22_500)
    expect(offerAmountFor(BUNDLE_MONTHLY, 'monthly', 'eur').offerMinor).toBe(2_250)
    expect(offerAmountFor(BUNDLE_MONTHLY, 'monthly', 'chf').offerMinor).toBe(1_750)
    expect(offerAmountFor(BUNDLE_MONTHLY, 'monthly', 'jpy').offerMinor).toBe(3_250)
  })

  test('keeps whole-unit currencies chargeable', () => {
    // HUF and TWD must be an exact multiple of 100 minor units, and so must the
    // discount — otherwise the net lands between whole forints.
    for (const cur of ['huf', 'twd'] as const) {
      const yearly = offerAmountFor(BUNDLE_YEARLY, 'yearly', cur)
      const monthly = offerAmountFor(BUNDLE_MONTHLY, 'monthly', cur)
      for (const a of [yearly, monthly]) {
        expect(a.offerMinor % 100).toBe(0)
        expect(a.discountMinor % 100).toBe(0)
      }
    }
  })

  test('every currency yields a positive, smaller-than-Bundle price', () => {
    for (const floors of [BUNDLE_YEARLY, BUNDLE_MONTHLY]) {
      const plan = floors === BUNDLE_YEARLY ? 'yearly' : 'monthly'
      for (const cur of Object.keys(floors)) {
        const a = offerAmountFor(floors, plan, cur)
        expect(a.discountMinor).toBeGreaterThan(0)
        expect(a.offerMinor).toBeGreaterThan(0)
        expect(a.offerMinor).toBeLessThan(a.bundleMinor)
      }
    }
  })

  test('falls back to the USD floor for a currency the catalog lacks', () => {
    expect(offerAmountFor(BUNDLE_YEARLY, 'yearly', 'xxx').offerMinor).toBe(20_000)
  })
})

describe('blockFor', () => {
  const launch = Date.parse(WELCOME_OFFER_ELIGIBLE_BEFORE_ISO) / 1000
  const sub = { created: launch - 86_400, metadata: {} }
  const during = new Date('2026-10-14T12:00:00Z')

  test('lets a pre-launch Ark+ subscriber through during the window', () => {
    expect(blockFor(sub, 'ark-plus', during)).toBeNull()
  })

  test('turns away a subscription from launch day on', () => {
    expect(blockFor({ ...sub, created: launch }, 'ark-plus', during)).toBe('not_eligible')
  })

  test('turns away anything that is not Ark+', () => {
    expect(blockFor(sub, 'circle', during)).toBe('not_eligible')
    expect(blockFor(sub, null, during)).toBe('not_eligible')
  })

  test('turns away a second redemption', () => {
    expect(blockFor(sub, 'bundle', during)).toBe('already_bundle')
    // The marker alone is enough, e.g. after a later debundle back to Ark+.
    const taken = { ...sub, metadata: { welcome_offer: WELCOME_OFFER_COHORT } }
    expect(blockFor(taken, 'ark-plus', during)).toBe('already_bundle')
  })

  test('closes at the same moment the coupons stop being redeemable', () => {
    const deadline = Date.parse(WELCOME_OFFER_REDEEM_BY_ISO)
    expect(blockFor(sub, 'ark-plus', new Date(deadline))).toBeNull()
    expect(blockFor(sub, 'ark-plus', new Date(deadline + 1000))).toBe('expired')
  })

  test('someone who took it hears that, not "closed", after the window', () => {
    const after = new Date(Date.parse(WELCOME_OFFER_REDEEM_BY_ISO) + 86_400_000)
    expect(blockFor(sub, 'bundle', after)).toBe('already_bundle')
  })
})

describe('welcomeDiscountActive', () => {
  const redeemed = (plan: string, at = '2026-10-10T12:00:00Z') => ({
    welcome_offer: WELCOME_OFFER_COHORT,
    welcome_offer_plan: plan,
    welcome_offer_redeemed_at: at,
  })

  test('is off for a subscription that never took the offer', () => {
    expect(welcomeDiscountActive({ tier: 'ark-plus' })).toBe(false)
    expect(welcomeDiscountActive(null)).toBe(false)
  })

  test('runs three months for a monthly member', () => {
    expect(welcomeDiscountActive(redeemed('monthly'), new Date('2027-01-10T11:00:00Z'))).toBe(true)
    expect(welcomeDiscountActive(redeemed('monthly'), new Date('2027-01-10T13:00:00Z'))).toBe(false)
  })

  test('runs a year for an annual member', () => {
    expect(welcomeDiscountActive(redeemed('yearly'), new Date('2027-10-10T11:00:00Z'))).toBe(true)
    expect(welcomeDiscountActive(redeemed('yearly'), new Date('2027-10-10T13:00:00Z'))).toBe(false)
  })

  test('holds back a second discount when the date never got written', () => {
    const noDate = { welcome_offer: WELCOME_OFFER_COHORT, welcome_offer_plan: 'monthly' }
    expect(welcomeDiscountActive(noDate, new Date('2030-01-01T00:00:00Z'))).toBe(true)
  })
})

describe('redeemIdempotencyKey', () => {
  test('is the subscription plus its card', () => {
    expect(redeemIdempotencyKey({ id: 'sub_1', default_payment_method: 'pm_1' })).toBe(
      `welcome-offer:${WELCOME_OFFER_COHORT}:sub_1:pm_1`,
    )
    expect(redeemIdempotencyKey({ id: 'sub_1', default_payment_method: { id: 'pm_2' } })).toBe(
      `welcome-offer:${WELCOME_OFFER_COHORT}:sub_1:pm_2`,
    )
  })

  test('falls back to the customer default when the subscription names no card', () => {
    expect(redeemIdempotencyKey({ id: 'sub_1', default_payment_method: null })).toBe(
      `welcome-offer:${WELCOME_OFFER_COHORT}:sub_1:customer-default`,
    )
  })
})
