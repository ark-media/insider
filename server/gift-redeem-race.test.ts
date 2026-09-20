// redeemGiftForRecipient — the call that loses the claim gives back its grant.
//
// A redeem grants (Beehiiv premium, Circle group) BEFORE it atomically claims
// the gift, so a provisioning outage can't burn a gift. The cost is that the
// loser of two concurrent redeems has been granted too, with no membership row
// behind it, and would keep the feed until the nightly reconciler. These tests
// pin what the loser does about that — and that a recipient racing THEMSELVES
// (a double-click) is left alone, because their grant is the winner's.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { neonMockModule, silenceExpectedConsole, type SqlCall } from './test-utils'

mock.module('stripe', () => ({ default: class {}, __esModule: true }))

const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string, values: unknown[]) => unknown = () => []
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql, values) => nextSqlResult(sql, values)),
)

import { redeemGiftForRecipient } from './routes/gift'
import { getDb } from './lib/db'
import type { Deps } from './lib/route'
import type { GiftRow, MembershipRow } from './lib/membership'
import type Stripe from 'stripe'

const ENV = {
  DATABASE_URL: 'postgres://test',
  BEEHIIV_API_KEY: 'bh-token',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test',
  CIRCLE_ADMIN_API_TOKEN: 'circle-token',
  CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: '111',
}

const LOSER = { email: 'loser@example.com', name: 'Lo Ser', auth0Sub: 'auth0|loser' }

function pendingGift(tier: GiftRow['tier']): GiftRow {
  return {
    redemption_token: 'tok_1',
    tier,
    plan: '1yr',
    amount_cents: 8000,
    currency: 'usd',
    giver_sub: null,
    status: 'pending',
    redeemed_by: null,
  }
}

// What the database says. `membership` is the loser's own row; `giftAfter` is
// the gift as the loser finds it once the claim has been lost.
let membership: MembershipRow | null = null
let giftAfter: GiftRow | null = null

const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  const method = init?.method ?? 'GET'
  fetchCalls.push({
    url,
    method,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  })
  if (url.includes('api.beehiiv.com')) {
    // The loser IS on premium by the time they lose: the grant put them there.
    const downgraded = method === 'PUT'
    return new Response(
      JSON.stringify({
        data: {
          id: 'sub_loser',
          email: LOSER.email,
          status: 'active',
          subscription_tier: downgraded ? 'free' : 'premium',
        },
      }),
      { status: 200 },
    )
  }
  return new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()

afterAll(() => {
  globalThis.fetch = originalFetch
})

const activations: Array<{ arkPlusFromMs: number | null; circleFromMs: number | null }> = []
const activator = {
  activateGiftForRecipient: async (opts: {
    arkPlusFromMs: number | null
    circleFromMs: number | null
  }) => {
    activations.push(opts)
    return {
      arkPlusEndsAt: opts.arkPlusFromMs != null ? '2099-01-01T00:00:00.000Z' : null,
      circleEndsAt: opts.circleFromMs != null ? '2099-01-01T00:00:00.000Z' : null,
    }
  },
} as unknown as Deps['activator']

beforeEach(() => {
  sqlCalls.length = 0
  fetchCalls.length = 0
  activations.length = 0
  membership = null
  giftAfter = { ...pendingGift('bundle'), status: 'redeemed', redeemed_by: 'auth0|winner' }
  nextSqlResult = (sql) => {
    // The claim: someone else got there first, so no row comes back.
    if (/update gift set status = 'redeemed'/.test(sql)) return []
    if (/from gift/.test(sql)) return giftAfter ? [giftAfter] : []
    if (/from membership where auth0_sub/.test(sql)) return membership ? [membership] : []
    return []
  }
})

const redeem = (tier: GiftRow['tier']) =>
  redeemGiftForRecipient(
    { sql: getDb(ENV), stripe: {} as Stripe, env: ENV, activator },
    pendingGift(tier),
    LOSER,
  )

const beehiivDowngrades = () =>
  fetchCalls.filter((c) => c.url.includes('api.beehiiv.com') && c.method === 'PUT')
const circleRemovals = () =>
  fetchCalls.filter((c) => c.url.includes('circle') && c.method === 'DELETE')
const wroteMembership = () => sqlCalls.some((c) => /insert into membership/i.test(c.sql))

describe('redeemGiftForRecipient — losing the claim', () => {
  test('a loser with no membership of their own is put back to free on both axes', async () => {
    const result = await redeem('bundle')

    expect(result).toEqual({ ok: false, error: 'already_redeemed' })
    // They were granted first — that is the order under test.
    expect(activations).toHaveLength(1)

    expect(beehiivDowngrades()).toHaveLength(1)
    expect(beehiivDowngrades()[0]!.body).toEqual({ tier: 'free' })
    expect(circleRemovals()).toHaveLength(1)
    expect(circleRemovals()[0]!.url).toContain(encodeURIComponent(LOSER.email))
    // And the loser never gets a row.
    expect(wroteMembership()).toBe(false)
  })

  test('an Ark+ gift only undoes the Ark+ axis', async () => {
    await redeem('ark-plus')

    expect(beehiivDowngrades()).toHaveLength(1)
    expect(fetchCalls.some((c) => c.url.includes('circle'))).toBe(false)
  })

  test("an axis the loser holds in their own right is not taken with it", async () => {
    // Already in the Fold on their own subscription; the bundle gift would have
    // added Ark+. Only the Ark+ grant is this call's to take back.
    membership = {
      auth0_sub: LOSER.auth0Sub,
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      tier: 'circle',
      status: 'active',
      plan: 'monthly',
      amount_cents: 900,
      current_period_end: '2099-01-01T00:00:00.000Z',
      cancel_at: null,
      ark_plus_gift_expires_at: null,
      circle_gift_expires_at: null,
    } as MembershipRow

    await redeem('bundle')

    expect(activations[0]).toMatchObject({ circleFromMs: null })
    expect(beehiivDowngrades()).toHaveLength(1)
    expect(circleRemovals()).toHaveLength(0)
  })

  test('a loser whose own gift term already carries Ark+ keeps premium', async () => {
    membership = {
      auth0_sub: LOSER.auth0Sub,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier: 'ark-plus',
      status: 'active',
      plan: '1yr',
      amount_cents: 8000,
      current_period_end: null,
      cancel_at: null,
      ark_plus_gift_expires_at: '2099-01-01T00:00:00.000Z',
      circle_gift_expires_at: null,
    } as MembershipRow

    await redeem('ark-plus')

    expect(beehiivDowngrades()).toHaveLength(0)
  })

  test('racing yourself (a double-click) undoes nothing — the grant is the winner\'s', async () => {
    // The winner claims BEFORE it upserts the row, so from here the row may not
    // exist yet; `redeemed_by` is what says the grant is legitimate.
    giftAfter = { ...pendingGift('bundle'), status: 'redeemed', redeemed_by: LOSER.auth0Sub }
    membership = null

    const result = await redeem('bundle')

    expect(result).toEqual({ ok: false, error: 'already_redeemed' })
    expect(beehiivDowngrades()).toHaveLength(0)
    expect(circleRemovals()).toHaveLength(0)
  })

  test('a gift voided mid-flight is undone like any other lost claim', async () => {
    giftAfter = { ...pendingGift('ark-plus'), status: 'void' }

    await redeem('ark-plus')

    expect(beehiivDowngrades()).toHaveLength(1)
  })

  test('a failing undo still answers already_redeemed rather than throwing', async () => {
    nextSqlResult = (sql) => {
      if (/update gift set status = 'redeemed'/.test(sql)) return []
      if (/from gift/.test(sql)) throw new Error('neon down')
      return []
    }

    expect(await redeem('bundle')).toEqual({ ok: false, error: 'already_redeemed' })
  })
})
