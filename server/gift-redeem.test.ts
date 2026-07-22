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
    expect(p.creditArkPlus).toBe(false)
    expect(p.creditCircle).toBe(false)
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

describe('planGiftRedemption — overlap with a live paid subscription → credit', () => {
  test('Ark+ gift on an Ark+ sub credits, grants nothing', () => {
    const p = planGiftRedemption({ tier: 'ark-plus' }, paidSub('ark-plus'), NOW)
    expect(p.hasPaidSub).toBe(true)
    expect(p.grantArkPlus).toBe(false)
    expect(p.creditArkPlus).toBe(true)
    expect(p.arkPlusFromMs).toBeNull()
    // Row keeps the subscribed tier; effective tier is unchanged.
    expect(p.rowTier).toBe('ark-plus')
    expect(p.effectiveTier).toBe('ark-plus')
  })

  test('Bundle gift on an Ark+ sub grants Circle AND credits the Ark+ overlap (mixed)', () => {
    const p = planGiftRedemption({ tier: 'bundle' }, paidSub('ark-plus'), NOW)
    expect(p.hasPaidSub).toBe(true)
    expect(p.grantArkPlus).toBe(false)
    expect(p.grantCircle).toBe(true)
    expect(p.creditArkPlus).toBe(true)
    expect(p.creditCircle).toBe(false)
    expect(p.circleFromMs).toBe(NOW)
    // Row keeps the subscribed (ark-plus) tier; effective is the union → bundle.
    expect(p.rowTier).toBe('ark-plus')
    expect(p.effectiveTier).toBe('bundle')
  })

  test('Community gift on a Bundle sub credits, grants nothing', () => {
    const p = planGiftRedemption({ tier: 'circle' }, paidSub('bundle'), NOW)
    expect(p.grantCircle).toBe(false)
    expect(p.creditCircle).toBe(true)
    expect(p.rowTier).toBe('bundle')
    expect(p.effectiveTier).toBe('bundle')
  })

  test('Ark+ gift on a Community-only sub grants Ark+; effective tier unions to bundle', () => {
    const p = planGiftRedemption({ tier: 'ark-plus' }, paidSub('circle'), NOW)
    expect(p.grantArkPlus).toBe(true)
    expect(p.creditArkPlus).toBe(false)
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
  test('canceled sub falls through to a fresh gift term (grant, not credit)', () => {
    const row = existing({
      tier: 'ark-plus',
      status: 'canceled',
      stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1',
    })
    const p = planGiftRedemption({ tier: 'ark-plus' }, row, NOW)
    expect(p.hasPaidSub).toBe(false)
    expect(p.grantArkPlus).toBe(true)
    expect(p.creditArkPlus).toBe(false)
    expect(p.arkPlusFromMs).toBe(NOW)
  })
})
