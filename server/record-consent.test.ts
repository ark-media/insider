// Unit tests for POST /api/stripe/record-consent.
//
// The route is the durable half of checkout consent: the browser gates its pay
// button on the checkboxes, and this is what makes the acceptance survive the
// browser. What matters here is that it writes the sentences it was given onto
// the named Checkout Session (merging, so the gift funnel's own metadata
// isn't clobbered), stamps a server-side timestamp, and refuses input it
// shouldn't record.
//
// Same strategy as checkout-create-session.test.ts: mock.module('stripe', …)
// swaps the SDK for a fake that records calls.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { ServerResponse } from 'node:http'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes,
  silenceExpectedConsole,
  type FakeRes,
  type MakeReqOpts,
  type Middleware,
} from './test-utils'

type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []
// Set to make checkout.sessions.update throw, standing in for Stripe refusing
// the write (an expired session, a session that has already been paid).
let updateError: Error | null = null

class FakeStripe {
  constructor(_key: string) {}
  checkout = {
    sessions: {
      create: async () => ({ id: 'cs_test_1', client_secret: 'cs_test_1_secret' }),
      retrieve: async () => ({}),
      update: async (id: string, args: Record<string, unknown>) => {
        stripeCalls.push({ method: 'checkout.sessions.update', args: [id, args] })
        if (updateError) throw updateError
        return { id }
      },
    },
  }
  customers = { list: async () => ({ data: [] }), create: async () => ({}) }
  subscriptions = { list: async () => ({ data: [] }) }
  prices = { list: async () => ({ data: [] }) }
  coupons = { list: async () => ({ data: [], has_more: false }) }
  paymentIntents = { retrieve: async () => ({}) }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'

const PATH = '/api/stripe/record-consent'
const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const TERMS = 'I agree to the Terms of Service and acknowledge the Privacy Policy.'
const RENEWAL =
  'I understand my subscription renews automatically at $8.00 per month until I cancel.'

function getHandler(): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(PATH)
}

function runHandler(handler: Middleware, opts: MakeReqOpts): Promise<FakeRes> {
  const req = makeFakeReq({ method: 'POST', url: PATH, ...opts })
  const res = makeFakeRes()
  return new Promise<FakeRes>((resolve, reject) => {
    const origEnd = res.end.bind(res)
    ;(res as unknown as { end: typeof origEnd }).end = ((chunk?: string | Buffer) => {
      origEnd(chunk as string | Buffer)
      resolve(res)
      return res
    }) as typeof origEnd
    handler(req, res as unknown as ServerResponse, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(res)
    })
  })
}

const post = (body: unknown, opts: MakeReqOpts = {}) =>
  runHandler(getHandler(), { body, ...opts })

function lastUpdate(): { id: string; metadata: Record<string, string> } {
  const call = [...stripeCalls]
    .reverse()
    .find((c) => c.method === 'checkout.sessions.update')
  if (!call) throw new Error('no checkout.sessions.update call recorded')
  return {
    id: call.args[0] as string,
    metadata: (call.args[1] as { metadata: Record<string, string> }).metadata,
  }
}

silenceExpectedConsole()
beforeEach(() => {
  stripeCalls.length = 0
  updateError = null
})

describe('POST /api/stripe/record-consent', () => {
  test('stamps the accepted statements and a server timestamp on the Session', async () => {
    const before = Date.now()
    const res = await post({
      checkout_session_id: 'cs_test_1',
      statements: [TERMS, RENEWAL],
    })

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })

    const { id, metadata } = lastUpdate()
    expect(id).toBe('cs_test_1')
    // 1-indexed in the order shown, so the record reads back as the buyer saw it.
    expect(metadata.consent_statement_1).toBe(TERMS)
    expect(metadata.consent_statement_2).toBe(RENEWAL)
    // Our clock, not the browser's — a client that can pick the timestamp can
    // pick one outside the window it was actually shown the sentences in.
    const at = Date.parse(metadata.consent_accepted_at)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  test('writes only consent keys, so a gift Session keeps its own metadata', async () => {
    await post({ checkout_session_id: 'cs_test_1', statements: [TERMS] })
    // Stripe merges a metadata update (a key is unset only by posting an empty
    // value for it), so naming nothing else is what preserves kind/giver_email.
    expect(Object.keys(lastUpdate().metadata).sort()).toEqual([
      'consent_accepted_at',
      'consent_statement_1',
    ])
  })

  test('a one-time purchase records just the one statement', async () => {
    const res = await post({ checkout_session_id: 'cs_test_1', statements: [TERMS] })
    expect(res.statusCode).toBe(200)
    expect(lastUpdate().metadata.consent_statement_2).toBeUndefined()
  })

  test('truncates a statement to Stripe metadata length', async () => {
    const long = 'x'.repeat(900)
    await post({ checkout_session_id: 'cs_test_1', statements: [long] })
    // Stripe caps a metadata value at 500 characters and the copy arrives from
    // a client that chose its own length; an over-long value would 400 the
    // write and lose the whole record.
    expect(lastUpdate().metadata.consent_statement_1.length).toBe(400)
  })

  test('400 without a Checkout Session id', async () => {
    const res = await post({ statements: [TERMS] })
    expect(res.statusCode).toBe(400)
    expect(stripeCalls).toHaveLength(0)
  })

  test('400 when the id is not a Checkout Session', async () => {
    const res = await post({ checkout_session_id: 'sub_123', statements: [TERMS] })
    expect(res.statusCode).toBe(400)
    expect(stripeCalls).toHaveLength(0)
  })

  test('400 when no statement was accepted', async () => {
    for (const statements of [undefined, [], [''], ['   '], 'nope']) {
      const res = await post({ checkout_session_id: 'cs_test_1', statements })
      expect(res.statusCode).toBe(400)
    }
    expect(stripeCalls).toHaveLength(0)
  })

  test('400 on more statements than a checkout can show', async () => {
    const res = await post({
      checkout_session_id: 'cs_test_1',
      statements: Array.from({ length: 9 }, (_, i) => `line ${i}`),
    })
    expect(res.statusCode).toBe(400)
    expect(stripeCalls).toHaveLength(0)
  })

  test('403 from another origin', async () => {
    const res = await post(
      { checkout_session_id: 'cs_test_1', statements: [TERMS] },
      { headers: { origin: 'https://evil.example' } },
    )
    expect(res.statusCode).toBe(403)
    expect(stripeCalls).toHaveLength(0)
  })

  test('502 when Stripe refuses the write', async () => {
    updateError = new Error('No such checkout session')
    const res = await post({ checkout_session_id: 'cs_test_1', statements: [TERMS] })
    // The browser treats this as non-fatal and pays anyway, so the status is
    // only a signal for logging — but it must not read as success.
    expect(res.statusCode).toBe(502)
  })

  test('rate-limits a caller hammering the endpoint', async () => {
    // One handler instance = one limiter, so the bucket is shared across calls.
    const handler = getHandler()
    const body = { checkout_session_id: 'cs_test_1', statements: [TERMS] }
    let limited: FakeRes | null = null
    for (let i = 0; i < 40; i++) {
      const res = await runHandler(handler, { body })
      if (res.statusCode === 429) {
        limited = res
        break
      }
    }
    expect(limited).not.toBeNull()
    expect(limited!.__headers()['retry-after']).toBeDefined()
  })
})
