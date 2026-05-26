// Unit tests for POST /api/stripe/create-checkout-session.
//
// Strategy mirrors gift.test.ts: mock.module('stripe', …) swaps the SDK for
// a fake whose customers/subscriptions/prices/checkout methods record args
// and return canned responses. We assert: input validation, the rate
// limiter, find-or-create behavior, and that the Session is created with
// `customer: customer.id`.

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

// Per-test config:
//   existingCustomers   → what customers.list({ email }) returns
//   subsByCustomer      → what subscriptions.list({ customer }) returns
//   nextSessionId       → id stamped onto the returned Session
let existingCustomers: Array<{ id: string; email: string }> = []
let subsByCustomer: Record<string, Array<{ id: string }>> = {}
let nextSessionId = 'cs_test_1'

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return {
        data: existingCustomers.filter((c) => c.email === args.email),
      }
    },
    create: async (args: { email: string; name?: string }) => {
      stripeCalls.push({ method: 'customers.create', args: [args] })
      return { id: 'cus_new', email: args.email, name: args.name }
    },
  }
  subscriptions = {
    list: async (args: { customer: string; status?: string; limit?: number }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      return { data: subsByCustomer[args.customer] ?? [] }
    },
    create: async () => ({}),
    update: async () => ({}),
    retrieve: async () => ({}),
  }
  prices = {
    retrieve: async (priceId: string) => {
      stripeCalls.push({ method: 'prices.retrieve', args: [priceId] })
      // 599¢ monthly, 5999¢ yearly — only the magnitude matters here, the
      // route reads unit_amount to compare against any custom_amount_cents.
      return {
        id: priceId,
        unit_amount: priceId.includes('monthly') ? 599 : 5999,
      }
    },
    create: async (args: unknown) => {
      stripeCalls.push({ method: 'prices.create', args: [args] })
      return { id: 'price_dyn_1' }
    },
  }
  checkout = {
    sessions: {
      create: async (args: Record<string, unknown>) => {
        stripeCalls.push({ method: 'checkout.sessions.create', args: [args] })
        return {
          id: nextSessionId,
          client_secret: `${nextSessionId}_secret_ABC`,
        }
      },
      retrieve: async () => ({}),
    },
  }
  coupons = {
    // Empty by default: existing promo tests live elsewhere and this route's
    // contract isn't promo-dependent.
    list: async () => ({ data: [], has_more: false }),
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
  paymentIntents = {
    create: async () => ({}),
    retrieve: async () => ({}),
    update: async () => ({}),
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

// Fixed price ids so we don't trigger prices.create on the default-amount
// path (the route reuses STRIPE_PRICE_MONTHLY/YEARLY when amount matches
// default).
const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_PRICE_MONTHLY: 'price_monthly',
  STRIPE_PRICE_YEARLY: 'price_yearly',
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
  url?: string
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
  stream.url = opts.url ?? '/api/stripe/create-checkout-session'
  stream.headers = opts.headers ?? { 'content-type': 'application/json' }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __header: (name: string) => string | undefined
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
    __body: () => body,
    __json: () => JSON.parse(body) as unknown,
    __header: (name: string) => headers[name.toLowerCase()],
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

// ---------------------------------------------------------------------------
// Global fetch mock (entitlement/SC reads it but they shouldn't fire here).
// Captures so we can fail the test if anything unexpected hits the network.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string }> = []
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  return new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  stripeCalls.length = 0
  fetchCalls.length = 0
  existingCustomers = []
  subsByCustomer = {}
  nextSessionId = 'cs_test_1'
})

// ---------------------------------------------------------------------------
const PATH = '/api/stripe/create-checkout-session'

// Each call to getHandler() returns a fresh middleware (new plugin instance
// → new rate limiter → new price cache). Tests that rely on rate-limiter
// state across calls should pin a single handler via getSharedHandler() and
// pass it to postWith().
async function post(body: unknown): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(getHandler(PATH), makeReq({ body }), res)
  return res
}

async function postWith(handler: Middleware, body: unknown): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(handler, makeReq({ body }), res)
  return res
}

function lastSessionCreateArgs(): Record<string, unknown> {
  const call = [...stripeCalls].reverse().find(
    (c) => c.method === 'checkout.sessions.create',
  )
  if (!call) throw new Error('no checkout.sessions.create call recorded')
  return call.args[0] as Record<string, unknown>
}

// ===========================================================================
describe('POST /api/stripe/create-checkout-session — input validation', () => {
  test('400 when email missing', async () => {
    const res = await post({ plan: 'monthly' })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'Email is required.' })
  })

  test('400 when email is malformed', async () => {
    const res = await post({ email: '   foo', plan: 'monthly' })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'Please enter a valid email.' })
  })

  test('400 when plan is missing or invalid', async () => {
    const res = await post({ email: 'a@b.co' })
    expect(res.statusCode).toBe(400)
  })

  test('400 when name exceeds the length cap', async () => {
    const res = await post({
      email: 'a@b.co',
      name: 'x'.repeat(300),
      plan: 'monthly',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/stripe/create-checkout-session — find-or-create', () => {
  test('no matching customer → creates one', async () => {
    const res = await post({ email: 'new@example.com', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    const created = stripeCalls.find((c) => c.method === 'customers.create')
    expect(created).toBeTruthy()
    const session = lastSessionCreateArgs()
    expect(session.customer).toBe('cus_new')
  })

  test('single existing customer → reused, no create call', async () => {
    existingCustomers = [{ id: 'cus_existing', email: 'a@b.co' }]
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.find((c) => c.method === 'customers.create')).toBeUndefined()
    expect(lastSessionCreateArgs().customer).toBe('cus_existing')
  })

  test('multiple customers → picks one without an active subscription', async () => {
    existingCustomers = [
      { id: 'cus_with_sub', email: 'a@b.co' },
      { id: 'cus_clean', email: 'a@b.co' },
    ]
    subsByCustomer = { cus_with_sub: [{ id: 'sub_1' }] }
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_clean')
  })

  test('multiple customers all with active subs → falls back to the first', async () => {
    existingCustomers = [
      { id: 'cus_a', email: 'a@b.co' },
      { id: 'cus_b', email: 'a@b.co' },
    ]
    subsByCustomer = {
      cus_a: [{ id: 'sub_a' }],
      cus_b: [{ id: 'sub_b' }],
    }
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_a')
  })
})

describe('POST /api/stripe/create-checkout-session — session shape', () => {
  test('attaches customer.id to the Session and returns the client_secret', async () => {
    const res = await post({ email: 'a@b.co', name: 'A B', plan: 'yearly' })
    expect(res.statusCode).toBe(200)
    const json = res.__json() as Record<string, unknown>
    expect(json.client_secret).toBe('cs_test_1_secret_ABC')
    expect(json.checkout_session_id).toBe('cs_test_1')
    expect(json.plan).toBe('yearly')
    const args = lastSessionCreateArgs()
    expect(args.customer).toBe('cus_new')
    expect(args.mode).toBe('subscription')
  })
})

describe('POST /api/stripe/create-checkout-session — rate limit', () => {
  test('returns 429 after the 6th attempt with the same email', async () => {
    // Pin one handler so the rate-limiter bucket survives across calls.
    const handler = getHandler(PATH)
    const body = { email: 'spammer@example.com', plan: 'monthly' as const }
    // Capacity: 5 — first five should succeed, sixth should 429.
    for (let i = 0; i < 5; i += 1) {
      const ok = await postWith(handler, body)
      expect(ok.statusCode).toBe(200)
    }
    const blocked = await postWith(handler, body)
    expect(blocked.statusCode).toBe(429)
    expect(blocked.__header('retry-after')).toBeTruthy()
  })
})
