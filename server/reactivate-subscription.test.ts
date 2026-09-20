// Unit tests for POST /api/stripe/reactivate-subscription — undo a pending
// cancel. Proves the guard stack (method, origin, auth, ownership via the
// session email), that a scheduled cancel is cleared with exactly
// `cancel_at_period_end: false`, and that the endpoint is idempotent: a sub
// that isn't scheduled to cancel is left untouched but still reports success.
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
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import {
  createDevApiHarness,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  type Middleware,
  type FakeRes,
} from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []

// Per-test config: which customers match the email and which active sub (if
// any) each customer has. `current_period_end: null` models an itemless sub
// (items.data empty); cancel_at_period_end defaults to a normally-renewing sub.
let existingCustomers: Array<{ id: string; email: string }> = []
let subsByCustomer: Record<
  string,
  Array<{
    id: string
    current_period_end: number | null
    cancel_at_period_end?: boolean
    // A pending period-end change (what the annual→monthly save schedules), the
    // subscription's discount ids, and its billing interval.
    schedule?: string
    discounts?: string[]
    interval?: 'month' | 'year'
  }>
> = {}
// The subscription's discounts with coupons expanded — what the route re-reads
// before deciding which retention coupons survive the released schedule.
let expandedDiscounts: Array<Record<string, unknown>> = []
// current_period_end echoed back by subscriptions.update (the route reads it
// as next_charge_at). 2030-01-01, fixed for stable assertions.
const UPDATED_PERIOD_END = 1893456000

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return { data: existingCustomers.filter((c) => c.email === args.email) }
    },
  }
  subscriptions = {
    list: async (args: { customer: string; status?: string; limit?: number }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      const subs = (subsByCustomer[args.customer] ?? []).map((s) => ({
        id: s.id,
        // These flows manage the member's live subscription; default to 'active'
        // so the (status-filtered) live-subscription lookup matches it.
        status: 'active',
        cancel_at_period_end: s.cancel_at_period_end ?? false,
        customer: args.customer,
        schedule: s.schedule ?? null,
        discounts: s.discounts ?? [],
        items: {
          data:
            s.current_period_end == null
              ? []
              : [
                  {
                    current_period_end: s.current_period_end,
                    price: {
                      product: 'prod_ark_plus',
                      recurring: { interval: s.interval ?? 'month' },
                    },
                  },
                ],
        },
      }))
      return { data: subs }
    },
    retrieve: async (id: string, args?: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id, args] })
      return { id, discounts: expandedDiscounts }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      return {
        id,
        cancel_at_period_end: false,
        items: { data: [{ current_period_end: UPDATED_PERIOD_END }] },
      }
    },
  }
  subscriptionSchedules = {
    release: async (id: string) => {
      stripeCalls.push({ method: 'subscriptionSchedules.release', args: [id] })
      return { id }
    },
  }
  products = {
    retrieve: async (id: string) => ({ id, metadata: { entitlements: 'ark_plus' } }),
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

const PATH = '/api/stripe/reactivate-subscription'

function getHandler(path: string): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(path)
}

// Fake req/res — makeReq kept local: this route rejects an
// application/json content-type on an empty body, which makeFakeReq forces.
function makeReq(opts: {
  method?: string
  headers?: Record<string, string>
}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as Omit<
    IncomingMessage,
    'socket'
  > & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'POST'
  stream.url = PATH
  stream.headers = { ...(opts.headers ?? {}) }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

beforeEach(() => {
  stripeCalls.length = 0
  existingCustomers = []
  subsByCustomer = {}
  expandedDiscounts = []
})

// A signed ark_session cookie for `email`, so getSessionEmail authenticates.
async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function post(
  opts: { method?: string; cookie?: string; origin?: string } = {},
): Promise<FakeRes> {
  const res = makeRes()
  const headers: Record<string, string> = {}
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.origin) headers.origin = opts.origin
  await runHandler(getHandler(PATH), makeReq({ method: opts.method, headers }), res)
  return res
}

const PERIOD_END = 1798761600 // 2027-01-01, distinct from UPDATED_PERIOD_END

function withSub(
  over: {
    cancel_at_period_end?: boolean
    current_period_end?: number | null
    schedule?: string
    discounts?: string[]
    interval?: 'month' | 'year'
  } = {},
) {
  existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
  subsByCustomer = {
    cus_1: [
      {
        id: 'sub_1',
        current_period_end: over.current_period_end === undefined ? PERIOD_END : over.current_period_end,
        cancel_at_period_end: over.cancel_at_period_end ?? false,
        schedule: over.schedule,
        discounts: over.discounts,
        interval: over.interval,
      },
    ],
  }
}

// ===========================================================================
describe('POST /api/stripe/reactivate-subscription — guard stack', () => {
  test('405 on GET', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await post({ method: 'GET', cookie })
    expect(res.statusCode).toBe(405)
    expect(stripeCalls.length).toBe(0)
  })

  test('403 when the Origin header is cross-site', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await post({ cookie, origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect(res.__json()).toEqual({ error: 'bad_origin' })
    expect(stripeCalls.length).toBe(0)
  })

  test('401 when unauthenticated', async () => {
    const res = await post()
    expect(res.statusCode).toBe(401)
    expect(stripeCalls.length).toBe(0)
  })

  test('404 when the email has no active subscription', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {} // no active sub
    const cookie = await sessionCookie('member@example.com')
    const res = await post({ cookie })
    expect(res.statusCode).toBe(404)
    expect(stripeCalls.find((c) => c.method === 'subscriptions.update')).toBeUndefined()
  })
})

describe('POST /api/stripe/reactivate-subscription — behavior', () => {
  test('scheduled cancel → clears cancel_at_period_end and returns the renewal date', async () => {
    withSub({ cancel_at_period_end: true })
    const cookie = await sessionCookie('member@example.com')

    const res = await post({ cookie, origin: BASE_ENV.APP_BASE_URL })

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      ok: true,
      next_charge_at: new Date(UPDATED_PERIOD_END * 1000).toISOString(),
    })

    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect(update).toBeTruthy()
    expect(update!.args[0]).toBe('sub_1')
    // A plain resume: only the schedule is cleared — no coupon, nothing else.
    expect(update!.args[1]).toEqual({ cancel_at_period_end: false })
  })

  test('idempotent: not scheduled to cancel → no Stripe update, still reports success', async () => {
    withSub({ cancel_at_period_end: false })
    const cookie = await sessionCookie('member@example.com')

    const res = await post({ cookie })

    expect(res.statusCode).toBe(200)
    // The existing renewal date is reported, proving no update produced it.
    expect(res.__json()).toEqual({
      ok: true,
      next_charge_at: new Date(PERIOD_END * 1000).toISOString(),
    })
    expect(stripeCalls.find((c) => c.method === 'subscriptions.update')).toBeUndefined()
  })

  test('itemless subscription → 200 with a null next_charge_at, never a 500', async () => {
    withSub({ cancel_at_period_end: false, current_period_end: null })
    const cookie = await sessionCookie('member@example.com')

    const res = await post({ cookie })

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true, next_charge_at: null })
  })
})

// F4 — accept a save offer, then reactivate. The annual→monthly save attaches
// the MONTHLY supporter coupon beside a scheduled switch to monthly. Reactivate
// releases that schedule, so the member stays annual — and the coupon, priced
// for a month, would come off a whole year's invoice.
describe('POST /api/stripe/reactivate-subscription — a released schedule takes its coupon with it', () => {
  const discount = (id: string, metadata: Record<string, string>) => ({
    id,
    source: { type: 'coupon', coupon: { id: `coupon_${id}`, metadata } },
  })
  const MONTHLY_SUPPORTER = discount('di_supporter', {
    retention_offer: 'true',
    offer_kind: 'supporter_coupon',
    plan: 'monthly',
  })

  test('accept → reactivate: the monthly coupon is dropped from the annual subscription', async () => {
    withSub({ interval: 'year', schedule: 'sched_1', discounts: ['di_supporter'] })
    expandedDiscounts = [MONTHLY_SUPPORTER]

    const res = await post({
      cookie: await sessionCookie('member@example.com'),
      origin: BASE_ENV.APP_BASE_URL,
    })

    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'subscriptionSchedules.release')).toBe(true)
    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect(update!.args[1]).toEqual({ cancel_at_period_end: false, discounts: '' })
  })

  test('a coupon that fits the resumed plan stays, as does anything that is not a retention coupon', async () => {
    withSub({ interval: 'month', schedule: 'sched_1', discounts: ['di_supporter', 'di_promo'] })
    expandedDiscounts = [MONTHLY_SUPPORTER, discount('di_promo', { auto_apply: 'true' })]

    await post({
      cookie: await sessionCookie('member@example.com'),
      origin: BASE_ENV.APP_BASE_URL,
    })

    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    // Nothing dropped → the param is omitted and Stripe leaves discounts alone.
    expect(update!.args[1]).toEqual({ cancel_at_period_end: false })
  })

  test('no schedule released → discounts are never read or touched', async () => {
    withSub({ cancel_at_period_end: true, interval: 'year', discounts: ['di_supporter'] })
    expandedDiscounts = [MONTHLY_SUPPORTER]

    await post({
      cookie: await sessionCookie('member@example.com'),
      origin: BASE_ENV.APP_BASE_URL,
    })

    expect(stripeCalls.some((c) => c.method === 'subscriptions.retrieve')).toBe(false)
    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect(update!.args[1]).toEqual({ cancel_at_period_end: false })
  })
})
