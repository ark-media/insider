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
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
  }>
> = {}

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
        cancel_at_period_end: s.cancel_at_period_end ?? false,
        cancel_at: s.cancel_at ?? null,
        items: {
          data:
            s.current_period_end == null
              ? []
              : [{ current_period_end: s.current_period_end }],
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

const PATH = '/api/stripe/my-subscription'

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
  stream.method = opts.method ?? 'GET'
  stream.url = PATH
  stream.headers = { ...(opts.headers ?? {}) }
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

beforeEach(() => {
  stripeCalls.length = 0
  existingCustomers = []
  subsByCustomer = {}
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
    expect(res.__json()).toEqual({ cancelAtPeriodEnd: false, cancelAt: null })
  })

  test('normally renewing subscription → no pending cancel', async () => {
    existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
    subsByCustomer = { cus_1: [{ id: 'sub_1', current_period_end: PERIOD_END }] }
    const cookie = await sessionCookie('member@example.com')
    const res = await get({ cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ cancelAtPeriodEnd: false, cancelAt: null })
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
    expect(res.__json()).toEqual({ cancelAtPeriodEnd: true, cancelAt: null })
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
    expect(res.__json()).toEqual({ cancelAtPeriodEnd: false, cancelAt: null })
    const customerList = stripeCalls.find((c) => c.method === 'customers.list')
    expect((customerList!.args[0] as { email: string }).email).toBe(
      'member@example.com',
    )
  })
})
