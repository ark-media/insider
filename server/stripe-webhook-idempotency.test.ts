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
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// neon mock — each test stages a ledger outcome via `ledgerMode`.
// ---------------------------------------------------------------------------
//   claim        the leased insert wins (new id, or a STALE 'processing' row
//                re-claimed by the conflict arm — same one row back)
//   dedup        conflict with a 'done' row → nothing back, status reads 'done'
//   in_progress  conflict with a LIVE lease → nothing back, status 'processing'
//   throw        the ledger is down
//   no_migration / no_migration_dedup
//                migration 0004 not applied: the leased statement raises 42703
//                (undefined_column) and the handler falls back to the old
//                single-state insert, which claims / dedups.
type LedgerMode =
  | 'claim'
  | 'dedup'
  | 'in_progress'
  | 'throw'
  | 'no_migration'
  | 'no_migration_dedup'
let ledgerMode: LedgerMode = 'claim'
const sqlStatements: string[] = []
const isLeasedInsert = (text: string) =>
  text.includes('insert into stripe_webhook_events') && text.includes('claimed_at')

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?')
      sqlStatements.push(text)
      if (text.includes('insert into stripe_webhook_events')) {
        if (ledgerMode === 'throw') {
          return Promise.reject(new Error('ledger DB down'))
        }
        if (ledgerMode === 'no_migration' || ledgerMode === 'no_migration_dedup') {
          if (isLeasedInsert(text)) {
            return Promise.reject(
              Object.assign(new Error('column "status" of relation "stripe_webhook_events" does not exist'), {
                code: '42703',
              }),
            )
          }
          return Promise.resolve(ledgerMode === 'no_migration' ? [{ id: 'evt_1' }] : [])
        }
        // 'claim' → one row back (we hold the lease); otherwise zero rows.
        return Promise.resolve(ledgerMode === 'claim' ? [{ id: 'evt_1' }] : [])
      }
      if (text.includes('select status from stripe_webhook_events')) {
        return Promise.resolve([{ status: ledgerMode === 'in_progress' ? 'processing' : 'done' }])
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
const WEBHOOK_PATH = '/api/stripe/webhook'
const HEADERS = { 'stripe-signature': 'sig' }

// DATABASE_URL present → the ledger branch runs. Unique URL keeps getDb's
// per-URL neon cache isolated to this file. No AUTH0/CIRCLE/BEEHIIV keys, so
// dispatch stays inert beyond the ledger + the (log-only) event path.
const ENV = {
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh_test',
  DATABASE_URL: 'postgres://stub-webhook-idempotency-test',
}

function getHandler(): Middleware {
  return createDevApiHarness(devApiPlugin(ENV)).getHandler(WEBHOOK_PATH)
}

const makeReq = () =>
  makeFakeReq({ method: 'POST', url: WEBHOOK_PATH, body: '{}', headers: HEADERS })

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

// A claim is not a completion. It used to be released only in the handler's
// catch, so a function that timed out or crashed mid-dispatch left it behind and
// Stripe's retry was answered "already processed" — the event was lost.
describe('Stripe webhook idempotency ledger — the claim is a lease', () => {
  const statementsWith = (needle: string) => sqlStatements.filter((s) => s.includes(needle))

  test('the claim is taken as processing, atomically re-claimable only when stale', async () => {
    await dispatch(EVENT)
    const claim = ledgerInserts()[0]!
    expect(claim).toContain("'processing'")
    // One statement: the conflict arm re-claims a 'processing' row past its
    // lease and nothing else, so two concurrent deliveries can't both win.
    expect(claim).toContain('on conflict (id) do update')
    expect(claim).toContain("e.status = 'processing'")
    expect(claim).toContain('e.claimed_at < now() - make_interval(secs =>')
  })

  test('a successful dispatch marks the claim done', async () => {
    const res = await dispatch(EVENT)
    expect(res.statusCode).toBe(200)
    expect(statementsWith("set status = 'done'")).toHaveLength(1)
    expect(statementsWith('delete from stripe_webhook_events')).toHaveLength(0)
  })

  test('a stale processing claim (a crashed delivery) is taken over and the event runs', async () => {
    // The conflict arm hands the row back → this delivery holds the lease.
    ledgerMode = 'claim'
    const res = await dispatch(EVENT)
    expect(res.__json()).toEqual({ received: true })
  })

  test('a LIVE lease is not acked — non-2xx, so Stripe comes back', async () => {
    // Another delivery is mid-dispatch and may yet fail. A 200 here would be
    // the last Stripe ever said about this event.
    ledgerMode = 'in_progress'
    const res = await dispatch(EVENT)
    expect(res.statusCode).toBe(409)
    expect(res.__json()).toEqual({ error: 'event_in_progress' })
    expect(statementsWith("set status = 'done'")).toHaveLength(0)
  })

  test('a thrown dispatch still releases the claim, and is never marked done', async () => {
    // A gift PaymentIntent with no recipient is the cheapest handler that throws.
    const res = await dispatch({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', metadata: { kind: 'gift' } } },
    })
    expect(res.statusCode).toBe(500)
    expect(statementsWith('delete from stripe_webhook_events')).toHaveLength(1)
    expect(statementsWith("set status = 'done'")).toHaveLength(0)
  })
})

// Deploy-before-migrate has taken prod down before. The handler must run on a
// ledger that doesn't have the new columns yet.
describe('Stripe webhook idempotency ledger — migration 0004 not applied', () => {
  test('falls back to the single-state claim and processes the event', async () => {
    ledgerMode = 'no_migration'
    const res = await dispatch(EVENT)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true })
    // Leased attempt, then the legacy insert.
    expect(ledgerInserts()).toHaveLength(2)
    expect(ledgerInserts()[1]).toContain('on conflict (id) do nothing')
    // No `status` column to write.
    expect(sqlStatements.some((s) => s.includes("set status = 'done'"))).toBe(false)
  })

  test('the fallback still dedups a replay', async () => {
    ledgerMode = 'no_migration_dedup'
    const res = await dispatch(EVENT)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true, deduped: true })
    // Never asks for a column that isn't there.
    expect(sqlStatements.some((s) => s.includes('select status from'))).toBe(false)
  })
})
