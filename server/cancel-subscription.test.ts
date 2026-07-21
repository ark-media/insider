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
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { silenceExpectedConsole } from './test-utils'

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
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

function getHandler(path: string): Middleware {
  const handlers = new Map<string, Middleware>()
  const fakeServer = {
    middlewares: {
      use(p: string, handler: Middleware) {
        handlers.set(p, handler)
      },
    },
  }
  const plugin = devApiPlugin(BASE_ENV)
  ;(plugin.configureServer as unknown as (s: unknown) => void)(fakeServer)
  const h = handlers.get(path)
  if (!h) throw new Error(`handler not registered for ${path}`)
  return h
}

// ---------------------------------------------------------------------------
// Fake req/res
// ---------------------------------------------------------------------------
function makeReq(opts: {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}): IncomingMessage {
  const raw =
    opts.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(opts.body), 'utf8')
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'POST'
  stream.url = '/api/stripe/cancel-subscription'
  stream.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

type FakeRes = ServerResponse & {
  __json: () => unknown
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {}
  let body = ''
  let statusCode = 200
  let ended = false
  return {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    get headersSent() {
      return ended
    },
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value)
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()]
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === 'string' ? chunk : chunk.toString()
      ended = true
    },
    __json: () => JSON.parse(body) as unknown,
  } as unknown as FakeRes
}

function runHandler(handler: Middleware, req: IncomingMessage, res: FakeRes) {
  return new Promise<void>((resolve, reject) => {
    const origEnd = res.end.bind(res)
    ;(res as unknown as { end: typeof origEnd }).end = ((chunk?: string | Buffer) => {
      origEnd(chunk as string | Buffer)
      resolve()
      return res
    }) as typeof origEnd
    try {
      handler(req, res as ServerResponse, (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

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
        couponId: 'save20',
        label: 'Stay 20',
        percentOff: 20,
        amountOff: null,
        durationMonths: 3,
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
