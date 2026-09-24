// redeemGiftForRecipient — a gift that overlaps a paid subscription.
//
// Extend-first: the gift defers the member's own billing by its term, and a
// single-axis gift inside a Bundle is credited to the balance instead. Two
// things pinned here:
//   - the gift starts where PAID time ends (the period end), not now — pausing
//     from now cost the recipient whatever was left of a period they paid for;
//   - whatever the redemption changed in Stripe is recorded on the gift
//     (gift.stripe_effect), so a later refund or dispute can undo exactly it.

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
import { __resetPriceCacheForTests, SUPPORTED_CURRENCIES } from './lib/pricing'
import type { Deps } from './lib/route'
import type { GiftRow, MembershipRow } from './lib/membership'
import type Stripe from 'stripe'

const ENV = { DATABASE_URL: 'postgres://test' }
const RECIPIENT = { email: 'member@example.com', name: 'Mem Ber', auth0Sub: 'auth0|member' }
const DAY = 86_400

const originalFetch = globalThis.fetch
// Records Resend sends, for the unapplied-gift alert.
const emailsSent: Array<{ to: string; subject: string; html: string; idempotencyKey?: string }> = []
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url).includes('api.resend.com')) {
    const body = JSON.parse(String(init?.body)) as { to: string; subject: string; html: string }
    const headers = (init?.headers ?? {}) as Record<string, string>
    emailsSent.push({ ...body, idempotencyKey: headers['Idempotency-Key'] })
  }
  return new Response('{}', { status: 200 })
}) as unknown as typeof fetch
silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})

const activator = {
  activateGiftForRecipient: async () => ({ arkPlusEndsAt: null, circleEndsAt: null }),
} as unknown as Deps['activator']

function gift(tier: GiftRow['tier'], plan: '6mo' | '1yr', currency = 'usd'): GiftRow {
  return {
    redemption_token: 'tok_1',
    tier,
    plan,
    amount_cents: 4800,
    currency,
    giver_sub: null,
    status: 'pending',
    redeemed_by: null,
  }
}

function paidRow(tier: MembershipRow['tier']): MembershipRow {
  return {
    auth0_sub: RECIPIENT.auth0Sub,
    stripe_customer_id: 'cus_m',
    stripe_subscription_id: 'sub_m',
    tier,
    status: 'active',
    plan: 'monthly',
    amount_cents: 800,
    currency: 'usd',
    current_period_end: null,
    cancel_at: null,
    ark_plus_gift_expires_at: null,
    circle_gift_expires_at: null,
  }
}

let membership: MembershipRow | null = null
let liveSub: Record<string, unknown> = {}
const updates: Array<{ id: string; params: Record<string, unknown> }> = []
const balanceTxns: Array<{ customer: string; params: Record<string, unknown> }> = []

// Every gift price carries every supported currency, as the catalog does.
const giftPrice = (unit: number) => ({
  id: 'price_gift',
  product: 'prod_gift',
  unit_amount: unit,
  currency_options: Object.fromEntries(
    SUPPORTED_CURRENCIES.map((c) => [c, { unit_amount: unit }]),
  ),
})

const stripe = {
  subscriptions: {
    retrieve: async () => liveSub,
    update: async (id: string, params: Record<string, unknown>) => {
      updates.push({ id, params })
      return liveSub
    },
  },
  customers: {
    createBalanceTransaction: async (customer: string, params: Record<string, unknown>) => {
      balanceTxns.push({ customer, params })
      return { id: 'cbtxn_1' }
    },
  },
  prices: { list: async () => ({ data: [giftPrice(8000)] }) },
} as unknown as Stripe

beforeEach(() => {
  sqlCalls.length = 0
  updates.length = 0
  balanceTxns.length = 0
  emailsSent.length = 0
  __resetPriceCacheForTests()
  nextSqlResult = (sql) => {
    if (/update gift set status = 'redeemed'/.test(sql)) return [{ redemption_token: 'tok_1' }]
    if (/from membership where auth0_sub/.test(sql)) return membership ? [membership] : []
    return []
  }
})

const redeem = (g: GiftRow) =>
  redeemGiftForRecipient({ sql: getDb(ENV), stripe, env: ENV, activator }, g, RECIPIENT)

const recordedEffect = (): Record<string, unknown> | null => {
  const call = sqlCalls.find((c) => /update gift set stripe_effect/.test(c.sql))
  return call ? (JSON.parse(call.values[0] as string) as Record<string, unknown>) : null
}

describe('extending a paid subscription', () => {
  test('a monthly sub pauses from the END of its paid period, for the gift term', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 20 * DAY
    membership = paidRow('ark-plus')
    liveSub = {
      id: 'sub_m',
      schedule: null,
      pause_collection: null,
      items: {
        data: [{ current_period_end: periodEnd, price: { recurring: { interval: 'month' } } }],
      },
    }

    const result = await redeem(gift('ark-plus', '6mo'))
    expect(result).toMatchObject({ ok: true, applied: 'extended' })

    const pause = updates.find((u) => 'pause_collection' in u.params)
    expect(pause?.params.pause_collection).toEqual({
      behavior: 'keep_as_draft',
      resumes_at: periodEnd + 182 * DAY,
    })
    expect(recordedEffect()).toEqual({
      kind: 'pause',
      subscription_id: 'sub_m',
      previous_resumes_at: null,
      resumes_at: periodEnd + 182 * DAY,
    })
  })

  test('a second gift stacks after the pause an earlier one set, not over it', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 20 * DAY
    const earlierResume = periodEnd + 182 * DAY
    membership = paidRow('ark-plus')
    liveSub = {
      id: 'sub_m',
      schedule: null,
      pause_collection: { behavior: 'keep_as_draft', resumes_at: earlierResume },
      items: {
        data: [{ current_period_end: periodEnd, price: { recurring: { interval: 'month' } } }],
      },
    }

    await redeem(gift('ark-plus', '6mo'))
    const pause = updates.find((u) => 'pause_collection' in u.params)
    expect((pause?.params.pause_collection as { resumes_at: number }).resumes_at).toBe(
      earlierResume + 182 * DAY,
    )
    expect(recordedEffect()).toMatchObject({ previous_resumes_at: earlierResume })
  })

  test('an annual sub has its renewal pushed out by the term, and that is recorded', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 100 * DAY
    membership = { ...paidRow('ark-plus'), plan: 'yearly' }
    liveSub = {
      id: 'sub_m',
      schedule: null,
      items: {
        data: [{ current_period_end: periodEnd, price: { recurring: { interval: 'year' } } }],
      },
    }

    await redeem(gift('ark-plus', '1yr'))
    const push = updates.find((u) => 'trial_end' in u.params)
    expect(push?.params).toEqual({ trial_end: periodEnd + 365 * DAY, proration_behavior: 'none' })
    expect(recordedEffect()).toEqual({
      kind: 'trial_end',
      subscription_id: 'sub_m',
      previous_period_end: periodEnd,
      trial_end: periodEnd + 365 * DAY,
    })
  })
})

describe('crediting a Bundle subscriber', () => {
  test('a single-axis gift inside a Bundle is credited, and the credit recorded', async () => {
    membership = paidRow('bundle')
    liveSub = { id: 'sub_m', currency: 'usd' }

    const result = await redeem(gift('ark-plus', '1yr'))
    expect(result).toMatchObject({ ok: true, applied: 'credit' })
    expect(balanceTxns).toEqual([
      {
        customer: 'cus_m',
        params: { amount: -4800, currency: 'usd', description: 'Ark gift credit' },
      },
    ])
    expect(recordedEffect()).toEqual({
      kind: 'credit',
      customer_id: 'cus_m',
      balance_transaction_id: 'cbtxn_1',
      amount: 4800,
      currency: 'usd',
    })
  })
})

// A gift whose Stripe half didn't happen is spent all the same, so the
// recipient is told the truth and staff are alerted to handle it by hand.
describe('a gift that could not be applied in Stripe', () => {
  const ALERT_ENV = { ...ENV, RESEND_API_KEY: 're_test' }
  const redeemAlerting = (g: GiftRow) =>
    redeemGiftForRecipient({ sql: getDb(ALERT_ENV), stripe, env: ALERT_ENV, activator }, g, RECIPIENT)

  test('a gift in another currency than the Bundle sub is held, and support is alerted', async () => {
    membership = paidRow('bundle')
    liveSub = { id: 'sub_m', currency: 'cad' }

    const result = await redeemAlerting(gift('ark-plus', '1yr', 'usd'))
    expect(result).toMatchObject({ ok: true, applied: 'held' })
    expect(balanceTxns).toEqual([])
    expect(emailsSent).toHaveLength(1)
    expect(emailsSent[0]).toMatchObject({
      to: 'support@arkmedia.org',
      subject: 'Gift needs manual handling: member@example.com',
      idempotencyKey: 'gift_unapplied_tok_1',
    })
    expect(emailsSent[0]!.html).toContain('different currency')
    expect(emailsSent[0]!.html).toContain('CAD')
  })

  test('a failed extension is alerted too', async () => {
    membership = paidRow('ark-plus')
    liveSub = {
      id: 'sub_m',
      schedule: null,
      pause_collection: null,
      items: {
        data: [
          {
            current_period_end: Math.floor(Date.now() / 1000) + 20 * DAY,
            price: { recurring: { interval: 'month' } },
          },
        ],
      },
    }
    const failing = {
      ...stripe,
      subscriptions: {
        ...stripe.subscriptions,
        update: async () => {
          throw new Error('stripe down')
        },
      },
    } as unknown as Stripe

    const result = await redeemGiftForRecipient(
      { sql: getDb(ALERT_ENV), stripe: failing, env: ALERT_ENV, activator },
      gift('ark-plus', '6mo'),
      RECIPIENT,
    )
    expect(result).toMatchObject({ ok: true, applied: 'held' })
    expect(emailsSent).toHaveLength(1)
    expect(emailsSent[0]!.html).toContain('extension')
  })

  test('an applied gift sends no alert', async () => {
    membership = paidRow('bundle')
    liveSub = { id: 'sub_m', currency: 'usd' }

    const result = await redeemAlerting(gift('ark-plus', '1yr'))
    expect(result).toMatchObject({ ok: true, applied: 'credit' })
    expect(emailsSent).toEqual([])
  })
})
