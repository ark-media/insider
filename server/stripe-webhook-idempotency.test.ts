// Unit tests for the Stripe webhook idempotency ledger in
// server/routes/stripe.ts (the `stripe_webhook_events` claim-before-work gate).
//
// The existing stripe-webhook.test.ts runs WITHOUT DATABASE_URL, so that whole
// ledger branch is never exercised there. These tests stand it up with a mocked
// neon client so we can drive the three ledger outcomes the handler depends on
// for Stripe's at-least-once delivery:
//
//   1. First delivery  → insert claims the row → dispatch runs → 200 received.
//   2. Replay/retry    → insert hits on-conflict-do-nothing (0 rows) → the
//                        handler short-circuits to 200 { deduped: true } and
//                        does NOT re-dispatch (IDEM-01).
//   3. Ledger DB error → non-fatal: log + fall through + process anyway, so a
//                        transient DB blip can't drop a real event (FAIL-DB-01).
//
// We use invoice.payment_failed as the event because its dispatch path only
// logs — no SC/Auth0/Circle/Beehiiv fan-out — so the ledger behavior is the
// only thing under test.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { silenceExpectedConsole } from './test-utils'

// ---------------------------------------------------------------------------
// neon mock — each test stages a ledger outcome via `ledgerMode`.
// ---------------------------------------------------------------------------
type LedgerMode = 'claim' | 'dedup' | 'throw'
let ledgerMode: LedgerMode = 'claim'
const sqlStatements: string[] = []

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?')
      sqlStatements.push(text)
      if (text.includes('insert into stripe_webhook_events')) {
        if (ledgerMode === 'throw') {
          return Promise.reject(new Error('ledger DB down'))
        }
        // 'claim' → one row back (we won the insert); 'dedup' → zero rows
        // (on conflict do nothing, already processed).
        return Promise.resolve(ledgerMode === 'claim' ? [{ id: 'evt_1' }] : [])
      }
      return Promise.resolve([])
    }) as unknown,
  __esModule: true,
}))

// ---------------------------------------------------------------------------
// Stripe mock — constructEvent returns the per-test webhookEvent.
// ---------------------------------------------------------------------------
let webhookEvent: unknown = null

class FakeStripe {
  constructor(_key: string) {}
  customers = { retrieve: async (id: string) => ({ id, email: 'sub@example.com' }) }
  webhooks = {
    constructEvent: () => {
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

// Static import AFTER both mock.module calls.
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Harness (mirrors stripe-webhook.test.ts)
// ---------------------------------------------------------------------------
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

const WEBHOOK_PATH = '/api/stripe/webhook'
const HEADERS = { 'stripe-signature': 'sig' }

// DATABASE_URL present → the ledger branch runs. Unique URL keeps getDb's
// per-URL neon cache isolated to this file. No AUTH0/CIRCLE/BEEHIIV keys, so
// dispatch stays inert beyond the ledger + the (log-only) event path.
const ENV = {
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-key',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh_test',
  DATABASE_URL: 'postgres://stub-webhook-idempotency-test',
}

function getHandler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const fakeServer = {
    middlewares: {
      use(p: string, handler: Middleware) {
        handlers.set(p, handler)
      },
    },
  }
  const plugin = devApiPlugin(ENV)
  ;(plugin.configureServer as unknown as (s: unknown) => void)(fakeServer)
  const h = handlers.get(WEBHOOK_PATH)
  if (!h) throw new Error(`handler not registered for ${WEBHOOK_PATH}`)
  return h
}

function makeReq(): IncomingMessage {
  const stream = Readable.from([Buffer.from('{}', 'utf8')]) as unknown as Omit<
    IncomingMessage,
    'socket'
  > & { method?: string; url?: string; headers: Record<string, string>; socket: { remoteAddress: string } }
  stream.method = 'POST'
  stream.url = WEBHOOK_PATH
  stream.headers = HEADERS
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

async function dispatch(event: unknown) {
  webhookEvent = event
  const res = makeRes()
  await runHandler(getHandler(), makeReq(), res)
  return res
}

silenceExpectedConsole()

beforeEach(() => {
  ledgerMode = 'claim'
  webhookEvent = null
  sqlStatements.length = 0
})

afterAll(() => {
  // Restore the real fetch in case a sibling import touched it (defensive).
})

// A log-only event so the ledger gate is the only behavior under test.
const EVENT = { id: 'evt_1', type: 'invoice.payment_failed', data: { object: { id: 'in_1' } } }

const ledgerInserts = () =>
  sqlStatements.filter((s) => s.includes('insert into stripe_webhook_events'))

describe('Stripe webhook idempotency ledger', () => {
  test('first delivery claims the event and processes it', async () => {
    ledgerMode = 'claim'
    const res = await dispatch(EVENT)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true })
    expect(ledgerInserts()).toHaveLength(1)
  })

  test('replay/retry is deduped — 200 { deduped: true }, no re-dispatch', async () => {
    // on conflict (id) do nothing → 0 rows → the handler must short-circuit
    // before dispatch. This is the at-least-once safety net (IDEM-01).
    ledgerMode = 'dedup'
    const res = await dispatch(EVENT)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true, deduped: true })
    // The insert was attempted, but no further work ran for this event.
    expect(ledgerInserts()).toHaveLength(1)
  })

  test('ledger insert error is non-fatal — event still processed (FAIL-DB-01)', async () => {
    // A transient ledger DB error must not drop a real event. The handler logs
    // and falls through to dispatch; downstream effects rely on their own
    // idempotency if Stripe later retries.
    ledgerMode = 'throw'
    const res = await dispatch(EVENT)
    expect(res.statusCode).toBe(200)
    // Processed, NOT deduped — the claim never succeeded.
    expect(res.__json()).toEqual({ received: true })
  })
})
