// Unit tests for planGiftRedemption — the pure decision core of a gift
// redemption (routes/gift.ts). Covers the per-axis grant/credit split, term
// stacking, and the row/effective tier derivation, so the branching can't
// silently drift. No IO: every case is a plain function call with a fixed clock.

import { describe, test, expect, mock } from 'bun:test'

// planGiftRedemption is pure, but importing routes/gift.ts pulls in the Stripe
// SDK and the Neon driver transitively. Stub both so the module loads without a
// real key or DB (neither is touched by the function under test).
mock.module('stripe', () => ({ default: class {}, __esModule: true }))
mock.module('@neondatabase/serverless', () => ({
  neon: () => () => Promise.resolve([]),
  __esModule: true,
}))

import {
  giftCreditCents,
  planGiftRedemption,
  type GiftRedemptionExisting,
} from './routes/gift'

const NOW = 1_700_000_000_000
const FUTURE = new Date(NOW + 10 * 86_400_000).toISOString()
const PAST = new Date(NOW - 10 * 86_400_000).toISOString()

function existing(over: Partial<GiftRedemptionExisting>): GiftRedemptionExisting {
  return {
    tier: 'free',
    status: 'active',
    stripe_subscription_id: null,
    stripe_customer_id: null,
    ark_plus_gift_expires_at: null,
    circle_gift_expires_at: null,
    ...over,
  }
}

// A live paid subscription row of the given tier.
function paidSub(tier: GiftRedemptionExisting['tier']): GiftRedemptionExisting {
  return existing({
    tier,
    status: 'active',
    stripe_subscription_id: 'sub_1',
    stripe_customer_id: 'cus_1',
  })
}

describe('planGiftRedemption — fresh recipient (no membership)', () => {
  test('Ark+ gift grants the ark-plus axis from now', () => {
    const p = planGiftRedemption({ tier: 'ark-plus' }, null, NOW)
    expect(p.grantArkPlus).toBe(true)
    expect(p.grantCircle).toBe(false)
    expect(p.extendSub).toBe(false)
    expect(p.creditFull).toBe(false)
    expect(p.hasPaidSub).toBe(false)
    expect(p.arkPlusFromMs).toBe(NOW)
    expect(p.circleFromMs).toBeNull()
    expect(p.rowTier).toBe('ark-plus')
    expect(p.effectiveTier).toBe('ark-plus')
  })

  test('Bundle gift grants both axes from now', () => {
    const p = planGiftRedemption({ tier: 'bundle' }, null, NOW)
    expect(p.grantArkPlus).toBe(true)
    expect(p.grantCircle).toBe(true)
    expect(p.arkPlusFromMs).toBe(NOW)
    expect(p.circleFromMs).toBe(NOW)
    expect(p.rowTier).toBe('bundle')
    expect(p.effectiveTier).toBe('bundle')
  })

  test('Community gift grants only the circle axis', () => {
    const p = planGiftRedemption({ tier: 'circle' }, null, NOW)
    expect(p.grantArkPlus).toBe(false)
    expect(p.grantCircle).toBe(true)
    expect(p.arkPlusFromMs).toBeNull()
    expect(p.circleFromMs).toBe(NOW)
    expect(p.rowTier).toBe('circle')
    expect(p.effectiveTier).toBe('circle')
  })
})

describe('planGiftRedemption — overlap with a live paid subscription (extend-first, D5)', () => {
  test('Ark+ gift on an Ark+ sub extends the sub, grants/credits nothing', () => {
    const p = planGiftRedemption({ tier: 'ark-plus' }, paidSub('ark-plus'), NOW)
    expect(p.hasPaidSub).toBe(true)
    expect(p.grantArkPlus).toBe(false)
    expect(p.extendSub).toBe(true)
    expect(p.creditFull).toBe(false)
    expect(p.arkPlusFromMs).toBeNull()
    // Row keeps the subscribed tier; effective tier is unchanged.
    expect(p.rowTier).toBe('ark-plus')
    expect(p.effectiveTier).toBe('ark-plus')
  })

  test('Bundle gift on a Bundle sub extends the sub (exact-tier), grants nothing', () => {
    const p = planGiftRedemption({ tier: 'bundle' }, paidSub('bundle'), NOW)
    expect(p.grantArkPlus).toBe(false)
    expect(p.grantCircle).toBe(false)
    expect(p.extendSub).toBe(true)
    expect(p.creditFull).toBe(false)
    expect(p.rowTier).toBe('bundle')
    expect(p.effectiveTier).toBe('bundle')
  })

  test('Bundle gift on an Ark+ sub grants Circle AND extends the Ark+ sub (mixed)', () => {
    const p = planGiftRedemption({ tier: 'bundle' }, paidSub('ark-plus'), NOW)
    expect(p.hasPaidSub).toBe(true)
    expect(p.grantArkPlus).toBe(false)
    expect(p.grantCircle).toBe(true)
    expect(p.extendSub).toBe(true)
    expect(p.creditFull).toBe(false)
    expect(p.circleFromMs).toBe(NOW)
    // Row keeps the subscribed (ark-plus) tier; effective is the union → bundle.
    expect(p.rowTier).toBe('ark-plus')
    expect(p.effectiveTier).toBe('bundle')
  })

  test('Community gift fully inside a Bundle sub credits the full amount, grants/extends nothing', () => {
    const p = planGiftRedemption({ tier: 'circle' }, paidSub('bundle'), NOW)
    expect(p.grantCircle).toBe(false)
    expect(p.extendSub).toBe(false)
    expect(p.creditFull).toBe(true)
    expect(p.rowTier).toBe('bundle')
    expect(p.effectiveTier).toBe('bundle')
  })

  test('Ark+ gift fully inside a Bundle sub credits the full amount', () => {
    const p = planGiftRedemption({ tier: 'ark-plus' }, paidSub('bundle'), NOW)
    expect(p.grantArkPlus).toBe(false)
    expect(p.extendSub).toBe(false)
    expect(p.creditFull).toBe(true)
  })

  test('Ark+ gift on a Community-only sub grants Ark+ (no overlap → no extend/credit)', () => {
    const p = planGiftRedemption({ tier: 'ark-plus' }, paidSub('circle'), NOW)
    expect(p.grantArkPlus).toBe(true)
    expect(p.extendSub).toBe(false)
    expect(p.creditFull).toBe(false)
    expect(p.arkPlusFromMs).toBe(NOW)
    // The sub lacks ark-plus, so we grant it; the mirror must not strip the
    // Circle the recipient holds via their sub.
    expect(p.effectiveTier).toBe('bundle')
  })
})

describe('planGiftRedemption — stacking onto an existing gift term', () => {
  test('same-axis gift stacks: term starts at the current (future) expiry', () => {
    const row = existing({ tier: 'ark-plus', ark_plus_gift_expires_at: FUTURE })
    const p = planGiftRedemption({ tier: 'ark-plus' }, row, NOW)
    expect(p.grantArkPlus).toBe(true)
    expect(p.arkPlusFromMs).toBe(Date.parse(FUTURE))
    expect(p.rowTier).toBe('ark-plus')
    expect(p.effectiveTier).toBe('ark-plus')
  })

  test('expired gift term does not stack: term starts at now', () => {
    const row = existing({ tier: 'ark-plus', ark_plus_gift_expires_at: PAST })
    const p = planGiftRedemption({ tier: 'ark-plus' }, row, NOW)
    expect(p.arkPlusFromMs).toBe(NOW)
  })

  test('Bundle gift onto a live Ark+ gift term stacks Ark+, starts Circle fresh', () => {
    const row = existing({ tier: 'ark-plus', ark_plus_gift_expires_at: FUTURE })
    const p = planGiftRedemption({ tier: 'bundle' }, row, NOW)
    expect(p.arkPlusFromMs).toBe(Date.parse(FUTURE))
    expect(p.circleFromMs).toBe(NOW)
    expect(p.rowTier).toBe('bundle')
    expect(p.effectiveTier).toBe('bundle')
  })
})

describe('planGiftRedemption — a non-live subscription does not divert to credit', () => {
  test('canceled sub falls through to a fresh gift term (grant, not extend/credit)', () => {
    const row = existing({
      tier: 'ark-plus',
      status: 'canceled',
      stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1',
    })
    const p = planGiftRedemption({ tier: 'ark-plus' }, row, NOW)
    expect(p.hasPaidSub).toBe(false)
    expect(p.grantArkPlus).toBe(true)
    expect(p.extendSub).toBe(false)
    expect(p.creditFull).toBe(false)
    expect(p.arkPlusFromMs).toBe(NOW)
  })
})

describe('giftCreditCents — credit what was paid, never the list price', () => {
  const base = { listCents: 8000, giftCurrency: 'usd', subscriptionCurrency: 'usd' }

  test('credits the captured amount when it is below list', () => {
    // The bug this guards: a gift bought under a 50%-off auto-apply coupon used
    // to credit the full 8000 list price back as balance.
    expect(giftCreditCents({ ...base, paidCents: 4000 })).toBe(4000)
  })

  test('caps at list so a mis-stamped row cannot over-credit', () => {
    expect(giftCreditCents({ ...base, paidCents: 99_000 })).toBe(8000)
  })

  test('credits the full amount when it was paid at list', () => {
    expect(giftCreditCents({ ...base, paidCents: 8000 })).toBe(8000)
  })

  test('refuses to cross currencies rather than invent an FX rate', () => {
    // Cheap presentment currency in, expensive billing currency out — this was
    // the arbitrage. A Stripe balance only draws its own currency anyway.
    expect(
      giftCreditCents({
        paidCents: 998,
        listCents: 800,
        giftCurrency: 'sgd',
        subscriptionCurrency: 'gbp',
      }),
    ).toBeNull()
  })

  test('is case-insensitive about currency codes', () => {
    expect(
      giftCreditCents({ paidCents: 500, listCents: 800, giftCurrency: 'USD', subscriptionCurrency: 'usd' }),
    ).toBe(500)
  })

  test('refuses when the row carries no usable amount', () => {
    expect(giftCreditCents({ ...base, paidCents: null })).toBeNull()
    expect(giftCreditCents({ ...base, paidCents: 0 })).toBeNull()
    expect(giftCreditCents({ ...base, paidCents: -100 })).toBeNull()
  })

  test('refuses when the catalog list price is unresolvable', () => {
    expect(giftCreditCents({ ...base, listCents: 0, paidCents: 4000 })).toBeNull()
  })
})
