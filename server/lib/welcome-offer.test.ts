// The ICMB welcome offer's decision core — the parts that decide money and
// eligibility without Stripe or a database in the way.
//
// The pricing assertions are the point of this file: the offer is quoted as
// fixed prices ($200/yr, $20/mo) but the coupons are minted for 40 currencies
// by scaling the catalog's Bundle price, so what is pinned here is that the
// scaling reproduces the quoted USD figures exactly and stays chargeable in
// the currencies Stripe is fussy about.

import { describe, test, expect, mock } from 'bun:test'
import { neonMockModule, type SqlCall } from '../test-utils'

const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

const {
  blockFor,
  claimOffer,
  generateOfferCode,
  offerAmountFor,
  WELCOME_OFFER_REDEEM_BY_ISO,
  WELCOME_OFFER_USD_MINOR,
} = await import('./welcome-offer')
const { getDb } = await import('./db')

const ENV = { DATABASE_URL: 'postgres://stub-welcome-offer' }

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
  const row = {
    code: 'CMB-ACDE-FGHJ',
    email: 'reader@example.com',
    cohort: 'icmb_launch_2026',
    sent_at: null,
    claimed_at: null,
    redeemed_at: null,
    redeemed_subscription_id: null,
    redeemed_plan: null,
  }
  const during = new Date('2026-10-14T12:00:00Z')

  test('lets an invited, unredeemed member through during the window', () => {
    expect(blockFor(row, during)).toBeNull()
  })

  test('turns away someone with no roster row', () => {
    expect(blockFor(null, during)).toBe('not_invited')
  })

  test('turns away a second redemption', () => {
    expect(blockFor({ ...row, redeemed_at: '2026-10-10T00:00:00Z' }, during)).toBe(
      'already_redeemed',
    )
  })

  test('closes at the same moment the coupons stop being redeemable', () => {
    const deadline = Date.parse(WELCOME_OFFER_REDEEM_BY_ISO)
    expect(blockFor(row, new Date(deadline))).toBeNull()
    expect(blockFor(row, new Date(deadline + 1000))).toBe('expired')
  })

  test('a redeemed row reads as redeemed even after the window shuts', () => {
    const after = new Date(Date.parse(WELCOME_OFFER_REDEEM_BY_ISO) + 86_400_000)
    expect(blockFor({ ...row, redeemed_at: '2026-10-10T00:00:00Z' }, after)).toBe(
      'already_redeemed',
    )
  })
})

describe('generateOfferCode', () => {
  test('is prefixed, grouped, and free of look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateOfferCode()).toMatch(/^CMB-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/)
    }
  })

  test('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, generateOfferCode))
    expect(seen.size).toBe(500)
  })
})

describe('claimOffer', () => {
  test('claims only a row that is unredeemed and not already in flight', async () => {
    sqlCalls.length = 0
    nextSqlResult = () => [{ code: 'CMB-ACDE-FGHJ' }]
    const code = await claimOffer(getDb(ENV), 'Reader@Example.com ')
    expect(code).toBe('CMB-ACDE-FGHJ')

    const call = sqlCalls[0]!
    expect(call.sql).toContain('update welcome_offer_codes')
    expect(call.sql).toContain('redeemed_at is null')
    expect(call.sql).toContain('claimed_at is null')
    // The email is normalized before it reaches the query, so a member who
    // signs in with different casing still matches their roster row.
    expect(call.values[0]).toBe('reader@example.com')
  })

  test('returns null when the conditional update matches nothing', async () => {
    sqlCalls.length = 0
    nextSqlResult = () => []
    expect(await claimOffer(getDb(ENV), 'reader@example.com')).toBeNull()
  })
})
