// Unit tests for the customer.subscription.* webhook handling in
// server/routes/stripe.ts — specifically the SC cancel-schedule mirroring
// (ends_at / autorenew) and the existing delete path.
//
// Strategy mirrors gift.test.ts: mock.module('stripe', …) swaps the SDK for a
// fake whose webhooks.constructEvent returns a per-test `webhookEvent`; SC
// calls go through the global fetch mock and are asserted via `fetchCalls`.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { silenceExpectedConsole } from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
let webhookEvent: unknown = null

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    // emailForStripeCustomer only calls this when sub.customer is a string;
    // our fixtures pass an object, so this is a safety net.
    retrieve: async (id: string) => ({ id, email: 'sub@example.com' }),
  }
  webhooks = {
    constructEvent: (_raw: unknown, _sig: string, _secret: string) => {
      if (!webhookEvent) throw new Error('webhookEvent not configured for this test')
      return webhookEvent
    },
  }
  subscriptions = {
    create: async () => ({}),
    update: async () => ({}),
    retrieve: async () => ({}),
    list: async () => ({ data: [] }),
  }
  paymentIntents = { create: async () => ({}), retrieve: async () => ({}), update: async () => ({}) }
  prices = { create: async () => ({}) }
  checkout = { sessions: { create: async () => ({}), retrieve: async () => ({}) } }
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

// No AUTH0_* / CIRCLE_* keys → syncEntitlement short-circuits to 'skipped' and
// makes no fetch calls, so the only SC traffic in these tests is the cancel-
// schedule PATCH / delete DELETE we're asserting on.
const BASE_ENV = {
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-key',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh_test',
}

const SC_BASE = 'https://api.supportingcast.fm/v2/test-net'

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
function makeReq(opts: { headers?: Record<string, string> }): IncomingMessage {
  const raw = Buffer.from('{}', 'utf8')
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = 'POST'
  stream.url = '/api/stripe/webhook'
  stream.headers = opts.headers ?? {}
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

type FakeRes = ServerResponse & { __json: () => unknown }

function makeRes(): FakeRes {
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
    setHeader() {},
    getHeader() {},
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

// ---------------------------------------------------------------------------
// fetch mock (captures SC traffic)
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  let parsed: unknown
  if (init?.body && typeof init.body === 'string') {
    try {
      parsed = JSON.parse(init.body)
    } catch {
      parsed = init.body
    }
  }
  fetchCalls.push({ url, method: init?.method ?? 'GET', body: parsed })
  return new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  fetchCalls.length = 0
  webhookEvent = null
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WEBHOOK_PATH = '/api/stripe/webhook'
const HEADERS = { 'stripe-signature': 'sig' }
// Tue, 06 May 2027 — the period-end cancel_at in unix seconds.
const CANCEL_AT = 1809599040

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    customer: { id: 'cus_1', email: 'sub@example.com' },
    metadata: { sc_subscription_id: '3119346' },
    cancel_at: null,
    cancel_at_period_end: false,
    ...overrides,
  }
}

async function dispatch(event: unknown) {
  webhookEvent = event
  const res = makeRes()
  await runHandler(getHandler(WEBHOOK_PATH), makeReq({ headers: HEADERS }), res)
  return res
}

const scPatches = () =>
  fetchCalls.filter((c) => c.method === 'PATCH' && c.url === `${SC_BASE}/subscriptions/3119346`)

// ===========================================================================
describe('customer.subscription.updated — SC cancel-schedule mirroring', () => {
  test('scheduled cancel → PATCH ends_at + autorenew:false', async () => {
    const res = await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ cancel_at: CANCEL_AT, cancel_at_period_end: true }),
        previous_attributes: { cancel_at_period_end: false },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(scPatches()).toHaveLength(1)
    expect(scPatches()[0]!.body).toEqual({
      ends_at: new Date(CANCEL_AT * 1000).toISOString(),
      autorenew: false,
    })
  })

  test('un-cancel (cancel_at cleared) → PATCH ends_at:null + autorenew:true', async () => {
    await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ cancel_at: null, cancel_at_period_end: false }),
        previous_attributes: { cancel_at: CANCEL_AT, cancel_at_period_end: true },
      },
    })
    expect(scPatches()).toHaveLength(1)
    expect(scPatches()[0]!.body).toEqual({ ends_at: null, autorenew: true })
  })

  test('metadata-only update (no cancel fields changed) → no SC PATCH', async () => {
    await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub(),
        previous_attributes: { metadata: { plan: 'yearly' } },
      },
    })
    expect(scPatches()).toHaveLength(0)
  })

  test('cancel scheduled but no sc_subscription_id metadata → no SC PATCH', async () => {
    await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ metadata: {}, cancel_at: CANCEL_AT, cancel_at_period_end: true }),
        previous_attributes: { cancel_at_period_end: false },
      },
    })
    expect(fetchCalls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })
})

describe('customer.subscription.deleted — SC delete (existing behavior)', () => {
  test('deletes the SC subscription by metadata id', async () => {
    const res = await dispatch({
      type: 'customer.subscription.deleted',
      data: { object: makeSub({ status: 'canceled' }) },
    })
    expect(res.statusCode).toBe(200)
    const deletes = fetchCalls.filter(
      (c) => c.method === 'DELETE' && c.url === `${SC_BASE}/subscriptions/3119346`,
    )
    expect(deletes).toHaveLength(1)
  })
})
