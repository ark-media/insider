// Unit tests for POST /api/stripe/cancel-subscription — focused on the
// retention-survey additions: the reason is required and validated server-side
// (not just client-side), the offer_outcome is allowlisted, and a valid cancel
// still schedules cancel_at_period_end exactly as before.
//
// Harness mirrors checkout-create-session.test.ts: mock.module('stripe', …)
// swaps the SDK, and we drive the registered middleware with fake req/res. No
// DATABASE_URL is set, so the survey insert is skipped — that path is exercised
// separately; here we prove the validation + Stripe behavior.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
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
// any) each customer has. A sub carries the current_period_end the route reads.
let existingCustomers: Array<{ id: string; email: string }> = []
let subsByCustomer: Record<string, Array<{ id: string; current_period_end: number }>> = {}
// Coupons returned by coupons.list (drives the retention-offer endpoints).
let activeCoupons: Array<Record<string, unknown>> = []
// current_period_end echoed back by subscriptions.update (the accept endpoint
// reads it as next_charge_at). 2030-01-01, fixed for stable assertions.
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
        items: { data: [{ current_period_end: s.current_period_end }] },
      }))
      return { data: subs }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      return { id, items: { data: [{ current_period_end: UPDATED_PERIOD_END }] } }
    },
  }
  coupons = {
    list: async (args?: { starting_after?: string }) => {
      stripeCalls.push({ method: 'coupons.list', args: [args] })
      return { data: activeCoupons, has_more: false }
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

function getHandler(path: string): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(path)
}

// ---------------------------------------------------------------------------
// Fake req: same defaults the local helper used (POST to the cancel path).
// ---------------------------------------------------------------------------
const makeReq = (o: MakeReqOpts = {}) =>
  makeFakeReq({ method: 'POST', url: '/api/stripe/cancel-subscription', ...o })

silenceExpectedConsole()
beforeEach(() => {
  stripeCalls.length = 0
  existingCustomers = []
  subsByCustomer = {}
  activeCoupons = []
})

// A valid retention coupon (flagged metadata.retention_offer).
const retentionCoupon = (over: Record<string, unknown> = {}) => ({
  id: 'save20',
  valid: true,
  name: 'Stay 20',
  percent_off: 20,
  amount_off: null,
  currency: 'usd',
  duration_in_months: 3,
  metadata: { retention_offer: 'true' },
  ...over,
})

// A signed ark_session cookie for `email`, so getSessionEmail authenticates.
async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

const PATH = '/api/stripe/cancel-subscription'

async function post(opts: {
  body?: unknown
  cookie?: string
}): Promise<FakeRes> {
  const res = makeRes()
  const headers: Record<string, string> = opts.cookie ? { cookie: opts.cookie } : {}
  await runHandler(getHandler(PATH), makeReq({ body: opts.body, headers }), res)
  return res
}

// Generic call against any registered path (the retention endpoints share this
// route module's harness). Method defaults to GET.
async function call(opts: {
  path: string
  method?: string
  body?: unknown
  cookie?: string
}): Promise<FakeRes> {
  const res = makeRes()
  const headers: Record<string, string> = opts.cookie ? { cookie: opts.cookie } : {}
  await runHandler(
    getHandler(opts.path),
    makeReq({ method: opts.method ?? 'GET', body: opts.body, headers }),
    res,
  )
  return res
}

// An email with one customer holding one active sub.
function withActiveSub(email: string) {
  existingCustomers = [{ id: 'cus_1', email }]
  subsByCustomer = { cus_1: [{ id: 'sub_1', current_period_end: 1800000000 }] }
}

// ===========================================================================
describe('POST /api/stripe/cancel-subscription — auth + reason validation', () => {
  test('401 when unauthenticated', async () => {
    const res = await post({ body: { reason: 'too_expensive' } })
    expect(res.statusCode).toBe(401)
    expect(stripeCalls.length).toBe(0)
  })

  test('400 when reason is missing', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await post({ body: {}, cookie })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'A cancellation reason is required.' })
    // Reason is rejected before Stripe is ever touched.
    expect(stripeCalls.length).toBe(0)
  })

  test('400 when reason is not in the allowed list', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await post({ body: { reason: 'just_because' }, cookie })
    expect(res.statusCode).toBe(400)
    expect(stripeCalls.length).toBe(0)
  })
})

describe('POST /api/stripe/cancel-subscription — cancel behavior', () => {
  test('valid reason → schedules cancel_at_period_end and returns access_until', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    const periodEnd = 1893456000 // 2030-01-01, fixed so the assertion is stable
    subsByCustomer = { cus_1: [{ id: 'sub_1', current_period_end: periodEnd }] }
    const cookie = await sessionCookie('member@example.com')

    const res = await post({
      body: { reason: 'dont_listen_enough', note: '  too busy  ', offer_outcome: 'not_offered' },
      cookie,
    })

    expect(res.statusCode).toBe(200)
    const json = res.__json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(json.access_until).toBe(new Date(periodEnd * 1000).toISOString())

    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect(update).toBeTruthy()
    expect(update!.args[0]).toBe('sub_1')
    expect(update!.args[1]).toEqual({ cancel_at_period_end: true })
  })

  test('404 when the email has no active subscription', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {} // no active sub
    const cookie = await sessionCookie('member@example.com')
    const res = await post({ body: { reason: 'too_expensive' }, cookie })
    expect(res.statusCode).toBe(404)
    expect(stripeCalls.find((c) => c.method === 'subscriptions.update')).toBeUndefined()
  })
})

// ===========================================================================
describe('GET /api/stripe/retention-offer', () => {
  const PATH = '/api/stripe/retention-offer'

  test('401 when unauthenticated', async () => {
    const res = await call({ path: PATH })
    expect(res.statusCode).toBe(401)
  })

  test('not eligible when the email has no active subscription', async () => {
    const cookie = await sessionCookie('member@example.com')
    activeCoupons = [retentionCoupon()]
    const res = await call({ path: PATH, cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ eligible: false, offer: null })
  })

  test('not eligible when no retention coupon is configured', async () => {
    withActiveSub('member@example.com')
    activeCoupons = [] // none flagged
    const cookie = await sessionCookie('member@example.com')
    const res = await call({ path: PATH, cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ eligible: false, offer: null })
  })

  test('eligible: active sub + flagged coupon → returns the offer', async () => {
    withActiveSub('member@example.com')
    activeCoupons = [retentionCoupon()]
    const cookie = await sessionCookie('member@example.com')
    const res = await call({ path: PATH, cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      eligible: true,
      offer: {
        kind: 'supporter_coupon',
        couponId: 'save20',
        label: 'Stay 20',
        percentOff: 20,
        amountOff: null,
        durationMonths: 3,
        forever: false,
      },
    })
  })
})

describe('POST /api/stripe/accept-retention-offer', () => {
  const PATH = '/api/stripe/accept-retention-offer'

  test('401 when unauthenticated', async () => {
    const res = await call({ path: PATH, method: 'POST' })
    expect(res.statusCode).toBe(401)
  })

  test('404 when the email has no active subscription', async () => {
    activeCoupons = [retentionCoupon()]
    const cookie = await sessionCookie('member@example.com')
    const res = await call({ path: PATH, method: 'POST', cookie })
    expect(res.statusCode).toBe(404)
  })

  test('409 when no retention coupon is configured', async () => {
    withActiveSub('member@example.com')
    activeCoupons = []
    const cookie = await sessionCookie('member@example.com')
    const res = await call({ path: PATH, method: 'POST', cookie })
    expect(res.statusCode).toBe(409)
  })

  test('applies the coupon, clears the pending cancel, and returns the discount', async () => {
    withActiveSub('member@example.com')
    activeCoupons = [retentionCoupon()]
    const cookie = await sessionCookie('member@example.com')
    const res = await call({ path: PATH, method: 'POST', cookie })

    expect(res.statusCode).toBe(200)
    const json = res.__json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(json.percentOff).toBe(20)
    expect(json.durationMonths).toBe(3)
    expect(json.next_charge_at).toBe(new Date(UPDATED_PERIOD_END * 1000).toISOString())

    // Coupon is attached and any pending cancel is cleared in one update —
    // re-derived server-side, never trusted from the client.
    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect(update!.args[0]).toBe('sub_1')
    expect(update!.args[1]).toEqual({
      discounts: [{ coupon: 'save20' }],
      cancel_at_period_end: false,
    })
  })
})

afterAll(() => {})
