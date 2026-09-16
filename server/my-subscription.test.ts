// Unit tests for GET /api/stripe/my-subscription — the signed-in member's
// cancel schedule, read by the billing page to persist a "set to cancel" state
// across reloads. Proves the endpoint is session-keyed (401 without a cookie),
// reports the schedule only when cancel_at_period_end is set, and falls back
// to the item's current_period_end when Stripe omits cancel_at.
//
// Harness mirrors cancel-subscription.test.ts: mock.module('stripe', …) swaps
// the SDK, and we drive the registered middleware with fake req/res.

import {
  describe,
  test,
  expect,
  beforeEach,
  mock,
} from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  type Middleware,
  type FakeRes,
  type MakeReqOpts,
} from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []

// Per-test config: which customers match the email and which active sub (if
// any) each customer has. `current_period_end: null` models an itemless sub
// (items.data empty); cancel fields default to a normally-renewing sub.
let existingCustomers: Array<{ id: string; email: string }> = []
let subsByCustomer: Record<
  string,
  Array<{
    id: string
    current_period_end: number | null
    cancel_at_period_end?: boolean
    cancel_at?: number | null
    // The money on the sub. Left off by default so the schedule tests stay
    // about the schedule; the price/card tests set them.
    currency?: string
    unit_amount?: number
    // The currency the PRICE is quoted in, which is not always the one the
    // subscription bills in (currency_options).
    price_currency?: string
    interval?: 'month' | 'year'
    default_payment_method?: string | null
  }>
> = {}

// Payment methods the fake Stripe will return from paymentMethods.retrieve.
let paymentMethods: Record<
  string,
  { card?: { brand: string; last4: string; exp_month: number; exp_year: number } }
> = {}

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return { data: existingCustomers.filter((c) => c.email === args.email) }
    },
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'customers.retrieve', args: [id] })
      // No invoice-level default in these fixtures: the card, when there is
      // one, hangs off the subscription.
      return { id, invoice_settings: { default_payment_method: null } }
    },
  }
  paymentMethods = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'paymentMethods.retrieve', args: [id] })
      const pm = paymentMethods[id]
      if (!pm) throw new Error('no such payment method')
      return { id, ...pm }
    },
  }
  subscriptions = {
    list: async (args: { customer: string; status?: string; limit?: number }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      const subs = (subsByCustomer[args.customer] ?? []).map((s) => ({
        id: s.id,
        customer: args.customer,
        // The account page reads the member's live subscription; default to
        // 'active' so the (status-filtered) live-subscription lookup matches it.
        status: 'active',
        currency: s.currency,
        cancel_at_period_end: s.cancel_at_period_end ?? false,
        cancel_at: s.cancel_at ?? null,
        default_payment_method: s.default_payment_method ?? null,
        items: {
          data:
            s.current_period_end == null
              ? []
              : [
                  {
                    current_period_end: s.current_period_end,
                    price:
                      s.unit_amount == null
                        ? undefined
                        : {
                            unit_amount: s.unit_amount,
                            currency: s.price_currency ?? s.currency,
                            recurring: s.interval
                              ? { interval: s.interval }
                              : undefined,
                          },
                  },
                ],
        },
      }))
      return { data: subs }
    },
    update: async () => {
      throw new Error('not used in this file')
    },
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const PATH = '/api/stripe/my-subscription'

function getHandler(path: string): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(path)
}

// Fake req: same defaults the local helper used (GET to the my-subscription path).
const makeReq = (o: MakeReqOpts = {}) =>
  makeFakeReq({ method: 'GET', url: PATH, ...o })

beforeEach(() => {
  stripeCalls.length = 0
  existingCustomers = []
  subsByCustomer = {}
  paymentMethods = {}
})

// A signed ark_session cookie for `email`, so getSessionEmail authenticates.
async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function get(opts: { method?: string; cookie?: string } = {}): Promise<FakeRes> {
  const res = makeRes()
  const headers: Record<string, string> = opts.cookie ? { cookie: opts.cookie } : {}
  await runHandler(getHandler(PATH), makeReq({ method: opts.method, headers }), res)
  return res
}

const PERIOD_END = 1893456000 // 2030-01-01, fixed for stable assertions
const CANCEL_AT = 1896134400 // 2030-02-01

// ===========================================================================
describe('GET /api/stripe/my-subscription — method + auth', () => {
  test('405 on POST', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ method: 'POST', cookie })
    expect(res.statusCode).toBe(405)
    expect(stripeCalls.length).toBe(0)
  })

  test('401 when unauthenticated', async () => {
    const res = await get()
    expect(res.statusCode).toBe(401)
    expect(stripeCalls.length).toBe(0)
  })
})

describe('GET /api/stripe/my-subscription — cancel schedule', () => {
  test('no active subscription → no pending cancel', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {} // no active sub
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ cancelAtPeriodEnd: false, cancelAt: null, pendingChange: false, scheduledTier: null, periodEnd: null, plan: null, amountCents: null, currency: null, minorFactor: 100, card: null })
  })

  test('normally renewing subscription → no pending cancel', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = { cus_1: [{ id: 'sub_1', current_period_end: PERIOD_END }] }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      cancelAtPeriodEnd: false,
      cancelAt: null,
      pendingChange: false,
      scheduledTier: null,
      periodEnd: new Date(PERIOD_END * 1000).toISOString(),
      plan: null,
      amountCents: null,
      currency: undefined,
      minorFactor: 100,
      card: null,
    })
  })

  test('scheduled cancel → reports cancel_at as an ISO date', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: PERIOD_END,
          cancel_at_period_end: true,
          cancel_at: CANCEL_AT,
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      cancelAtPeriodEnd: true,
      cancelAt: new Date(CANCEL_AT * 1000).toISOString(),
      pendingChange: false,
      scheduledTier: null,
      periodEnd: new Date(PERIOD_END * 1000).toISOString(),
      plan: null,
      amountCents: null,
      currency: undefined,
      minorFactor: 100,
      card: null,
    })
  })

  test('scheduled cancel without cancel_at → falls back to current_period_end', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: PERIOD_END,
          cancel_at_period_end: true,
          cancel_at: null,
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      cancelAtPeriodEnd: true,
      cancelAt: new Date(PERIOD_END * 1000).toISOString(),
      pendingChange: false,
      scheduledTier: null,
      periodEnd: new Date(PERIOD_END * 1000).toISOString(),
      plan: null,
      amountCents: null,
      currency: undefined,
      minorFactor: 100,
      card: null,
    })
  })

  test('scheduled cancel with no date available at all → cancelAt null, still 200', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: null, // itemless sub
          cancel_at_period_end: true,
          cancel_at: null,
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ cancelAtPeriodEnd: true, cancelAt: null, pendingChange: false, scheduledTier: null, periodEnd: null, plan: null, amountCents: null, currency: undefined, minorFactor: 100, card: null })
  })

  test('only the session email is consulted — never a client-supplied one', async () => {
    existingCustomers = [
      { id: 'cus_other', email: 'other@example.com' },
      { id: 'cus_me', email: 'member@example.com' },
    ]
    subsByCustomer = {
      cus_other: [
        {
          id: 'sub_other',
          current_period_end: PERIOD_END,
          cancel_at_period_end: true,
          cancel_at: CANCEL_AT,
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    // member@ has no sub of their own, so other@'s pending cancel must not leak.
    expect(res.__json()).toEqual({ cancelAtPeriodEnd: false, cancelAt: null, pendingChange: false, scheduledTier: null, periodEnd: null, plan: null, amountCents: null, currency: null, minorFactor: 100, card: null })
    const customerList = stripeCalls.find((c) => c.method === 'customers.list')
    expect((customerList!.args[0] as { email: string }).email).toBe(
      'member@example.com',
    )
  })
})

// ===========================================================================
// The plan card's money and card-on-file. Every one of these can be absent for
// an honest reason, so what matters is that an absence lands as null rather
// than as a wrong number.
// ===========================================================================
describe('GET /api/stripe/my-subscription — price + card on file', () => {
  test('quotes the amount and cadence when the price bills in its own currency', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: PERIOD_END,
          currency: 'usd',
          unit_amount: 800,
          interval: 'month',
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    const body = res.__json() as Record<string, unknown>
    expect(body.amountCents).toBe(800)
    expect(body.currency).toBe('usd')
    expect(body.minorFactor).toBe(100)
    expect(body.plan).toBe('monthly')
  })

  test('zero-decimal currency reports its own minor-unit factor', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: PERIOD_END,
          currency: 'jpy',
          unit_amount: 1300,
          interval: 'year',
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    const body = res.__json() as Record<string, unknown>
    expect(body.amountCents).toBe(1300)
    expect(body.currency).toBe('jpy')
    // ¥1300 is 1300, not 130000 — quoting it at ×100 would be a 100× error on
    // the one number a member checks.
    expect(body.minorFactor).toBe(1)
    expect(body.plan).toBe('yearly')
  })

  test('drops the amount when the price is quoted in a currency it does not bill in', async () => {
    // A catalog price billed through currency_options reports the USD base
    // while the subscription charges the localized amount. Showing the base as
    // "your next charge" would be the wrong money.
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: PERIOD_END,
          currency: 'gbp',
          unit_amount: 800,
          price_currency: 'usd',
          interval: 'month',
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    const body = res.__json() as Record<string, unknown>
    expect(body.amountCents).toBeNull()
    expect(body.currency).toBe('gbp')
  })

  test("reports the subscription's own default payment method", async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: PERIOD_END,
          currency: 'usd',
          unit_amount: 800,
          interval: 'month',
          default_payment_method: 'pm_1',
        },
      ],
    }
    paymentMethods = {
      pm_1: { card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2028 } },
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect((res.__json() as Record<string, unknown>).card).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 4,
      expYear: 2028,
    })
  })

  test('an unreadable payment method drops the card rather than failing the request', async () => {
    // The renewal date is what this endpoint exists for. A deleted or
    // non-card payment method must not take it down with it.
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {
      cus_1: [
        {
          id: 'sub_1',
          current_period_end: PERIOD_END,
          currency: 'usd',
          unit_amount: 800,
          interval: 'month',
          default_payment_method: 'pm_missing',
        },
      ],
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    const body = res.__json() as Record<string, unknown>
    expect(body.card).toBeNull()
    expect(body.periodEnd).toBe(new Date(PERIOD_END * 1000).toISOString())
  })
})
