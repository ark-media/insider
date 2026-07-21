// Unit tests for the two halves of the survey-after-cancel flow:
//
//   POST /api/stripe/cancel-subscription — the reasons survey is now collected
//   *after* the cancel commits, so this endpoint no longer requires a reason; it
//   only allowlists offer_outcome and schedules cancel_at_period_end.
//
//   POST /api/stripe/cancellation-survey — attaches the member's checked reasons
//   to the row the cancel created. Stripe-free (DB-only), so with no DATABASE_URL
//   the write is skipped and we prove its guards: origin, auth, and the
//   survey_id / reasons validation that runs before the DB block.
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
// Coupons returned by coupons.list — part of the shared stripe mock harness.
let activeCoupons: Array<Record<string, unknown>> = []
// current_period_end echoed back by subscriptions.update. 2030-01-01, fixed for
// stable assertions.
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

// ===========================================================================
describe('POST /api/stripe/cancel-subscription — auth', () => {
  test('401 when unauthenticated', async () => {
    const res = await post({ body: { offer_outcome: 'not_offered' } })
    expect(res.statusCode).toBe(401)
    expect(stripeCalls.length).toBe(0)
  })
})

describe('POST /api/stripe/cancel-subscription — cancel behavior', () => {
  test('no reason needed → schedules cancel_at_period_end and returns access_until', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    const periodEnd = 1893456000 // 2030-01-01, fixed so the assertion is stable
    subsByCustomer = { cus_1: [{ id: 'sub_1', current_period_end: periodEnd }] }
    const cookie = await sessionCookie('member@example.com')

    // Body carries only offer_outcome now — reasons come later via the survey.
    const res = await post({ body: { offer_outcome: 'not_offered' }, cookie })

    expect(res.statusCode).toBe(200)
    const json = res.__json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(json.access_until).toBe(new Date(periodEnd * 1000).toISOString())
    // No DB in this harness, so no survey row / id is returned.
    expect(json.survey_id).toBeNull()

    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect(update).toBeTruthy()
    expect(update!.args[0]).toBe('sub_1')
    expect(update!.args[1]).toEqual({ cancel_at_period_end: true })
  })

  test('404 when the email has no active subscription', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = {} // no active sub
    const cookie = await sessionCookie('member@example.com')
    const res = await post({ body: { offer_outcome: 'not_offered' }, cookie })
    expect(res.statusCode).toBe(404)
    expect(stripeCalls.find((c) => c.method === 'subscriptions.update')).toBeUndefined()
  })
})

// ===========================================================================
// POST /api/stripe/cancellation-survey — the reasons attach afterward. This
// endpoint never touches Stripe; with no DATABASE_URL the write is skipped, so
// these prove the guards that run before the DB block.
// ===========================================================================
const SURVEY_PATH = '/api/stripe/cancellation-survey'

async function postSurvey(opts: {
  body?: unknown
  cookie?: string
  origin?: string
}): Promise<FakeRes> {
  const res = makeRes()
  const headers: Record<string, string> = {}
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.origin) headers.origin = opts.origin
  await runHandler(
    getHandler(SURVEY_PATH),
    makeFakeReq({ method: 'POST', url: SURVEY_PATH, body: opts.body, headers }),
    res,
  )
  return res
}

describe('POST /api/stripe/cancellation-survey — guards', () => {
  test('403 when the Origin does not match APP_BASE_URL', async () => {
    // Origin is checked before auth, so no cookie is needed to trip it.
    const res = await postSurvey({
      origin: 'http://evil.example',
      body: { survey_id: 1, reasons: ['too_expensive'] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.__json()).toEqual({ error: 'bad_origin' })
  })

  test('401 when unauthenticated', async () => {
    const res = await postSurvey({ body: { survey_id: 1, reasons: ['too_expensive'] } })
    expect(res.statusCode).toBe(401)
  })

  test('400 when survey_id is missing', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await postSurvey({ body: { reasons: ['too_expensive'] }, cookie })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'survey_id is required.' })
  })

  test('400 when reasons contains an unknown slug', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await postSurvey({
      body: { survey_id: 1, reasons: ['too_expensive', 'just_because'] },
      cookie,
    })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'Invalid cancellation reasons.' })
  })

  test('400 when reasons is not an array', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await postSurvey({
      body: { survey_id: 1, reasons: 'too_expensive' },
      cookie,
    })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'Invalid cancellation reasons.' })
  })
})

describe('POST /api/stripe/cancellation-survey — accepted bodies', () => {
  test('200 with valid reasons + note (write skipped without a DB)', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await postSurvey({
      body: { survey_id: '42', reasons: ['too_expensive', 'other'], note: 'meh' },
      cookie,
    })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
  })

  test('200 with an empty reasons array (the survey is optional)', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await postSurvey({ body: { survey_id: 1, reasons: [] }, cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
  })

  test('200 when survey_id arrives as a numeric string (bigint over the wire)', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await postSurvey({
      body: { survey_id: '9007199254740993', reasons: ['not_listening'] },
      cookie,
    })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
  })
})

afterAll(() => {})
