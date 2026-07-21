// Unit tests for the inbound Supporting Cast webhook at POST /api/sc/webhook.
//
// The webhook gates on a query-string secret (`?key=…`), dedupes against an
// idempotency ledger it READS first and WRITES only after a successful upsert,
// and upserts sc_feed_activations based on the event type (feed.activated /
// feed.access_revoked / audio.downloaded). Tests cover:
//   - 405 on non-POST
//   - 401 on missing / wrong key
//   - 500 when SC_WEBHOOK_SECRET unset
//   - 400 on invalid JSON
//   - DATABASE_URL absent → 200 received, no DB calls
//   - feed.activated → activation upsert (activated=true), ledger written after
//   - feed.access_revoked → revoke upsert (activated=false)
//   - incomplete payload (no email / no feed id) → 200 skipped, no writes
//   - unhandled event type → 200 skipped, no writes (nothing to dedupe later)
//   - already-recorded event_id → 200 deduped, no activation write
//   - upsert throws → 500 so SC retries (ledger NOT written); a ledger read
//     error is non-fatal and processing still happens

import {
  describe,
  test,
  expect,
  beforeEach,
  mock,
} from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// Neon mock — captures every tagged-template query. `nextSqlResult` controls
// what each query returns per test (keyed off the SQL text), and may throw to
// simulate a DB error. The idempotency dedupe is a `select 1 from
// sc_webhook_events`; the ledger write happens after a successful upsert.
// ---------------------------------------------------------------------------
type SqlCall = { sql: string; values: unknown[] }
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const merged = strings.join('?')
      sqlCalls.push({ sql: merged, values })
      return Promise.resolve(nextSqlResult(merged))
    }) as unknown,
  __esModule: true,
}))

// Static import AFTER mock.module so the plugin picks up the fake neon.
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
const WEBHOOK_PATH = '/api/sc/webhook'
const WEBHOOK_SECRET = 'scwh-test-1234567890abcdef'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  SC_NETWORK_ID: 'net_test',
  SC_API_KEY: 'sc_test',
  SC_WEBHOOK_SECRET: WEBHOOK_SECRET,
  // Distinct DATABASE_URL per test file — getDb caches by url across files.
  DATABASE_URL: 'postgres://stub-sc-webhook',
}

function envWithout(key: string): Record<string, string> {
  const copy = { ...BASE_ENV }
  delete copy[key]
  return copy
}

function buildHandler(env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(WEBHOOK_PATH)
}

// ---------------------------------------------------------------------------
// Fake req — POST + webhook URL defaults; `rawBody` passes exact bytes through.
// ---------------------------------------------------------------------------
function makeReq(opts: {
  method?: string
  url?: string
  body?: unknown
  rawBody?: string
}) {
  return makeFakeReq({
    method: opts.method ?? 'POST',
    url: opts.url ?? `${WEBHOOK_PATH}?key=${WEBHOOK_SECRET}`,
    body: opts.rawBody !== undefined ? opts.rawBody : opts.body,
  })
}

silenceExpectedConsole()

// Default: the dedupe `select 1 from sc_webhook_events` returns no row (this is
// a first delivery), and every other query returns []. Tests that need a
// duplicate stage the SELECT to return a row.
beforeEach(() => {
  sqlCalls.length = 0
  nextSqlResult = () => []
})

// ===========================================================================
// Auth + transport guards
// ===========================================================================

describe('sc webhook auth + transport', () => {
  test('405 on non-POST', async () => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
    expect(sqlCalls).toHaveLength(0)
  })

  test('401 when key missing', async () => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ url: WEBHOOK_PATH }), res)
    expect(res.statusCode).toBe(401)
    expect(sqlCalls).toHaveLength(0)
  })

  test('401 when key wrong', async () => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ url: `${WEBHOOK_PATH}?key=wrong` }), res)
    expect(res.statusCode).toBe(401)
    expect(sqlCalls).toHaveLength(0)
  })

  test('500 when SC_WEBHOOK_SECRET unset', async () => {
    const res = makeRes()
    await runHandler(buildHandler(envWithout('SC_WEBHOOK_SECRET')), makeReq({}), res)
    expect(res.statusCode).toBe(500)
  })

  test('400 on invalid JSON', async () => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ rawBody: '{not json' }), res)
    expect(res.statusCode).toBe(400)
    expect(sqlCalls).toHaveLength(0)
  })

  test('200 + no writes when DATABASE_URL absent', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(envWithout('DATABASE_URL')),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 'evt_1',
          member: { email: 'a@x.com' },
          feed: { id: 42 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(sqlCalls).toHaveLength(0)
  })
})

// ===========================================================================
// Event dispatch
// ===========================================================================

describe('sc webhook event dispatch', () => {
  test('feed.activated upserts an activation row (activated=true)', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 'evt_act_1',
          activated_at: '2026-07-16T10:00:00Z',
          member: { email: 'Reader@X.com' },
          feed: { id: 42 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true })

    const write = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(write).toBeDefined()
    // Email normalized (lowercased/trimmed), feed id and activated_at bound.
    expect(write!.values).toContain('reader@x.com')
    expect(write!.values).toContain(42)
    expect(write!.values).toContain('2026-07-16T10:00:00Z')
    // Re-activation clears revoked_at — the "resurrect a lapsed feed" clause.
    expect(write!.sql).toContain('revoked_at')

    // The ledger is written AFTER the upsert, and after it (ordering matters:
    // a pre-claim would drop the event on a write failure).
    const activationIdx = sqlCalls.findIndex((c) =>
      c.sql.includes('insert into sc_feed_activations'),
    )
    const ledgerIdx = sqlCalls.findIndex((c) =>
      c.sql.includes('insert into sc_webhook_events'),
    )
    expect(ledgerIdx).toBeGreaterThan(activationIdx)
    expect(sqlCalls[ledgerIdx]!.values).toContain('evt_act_1')
  })

  test('feed.access_revoked upserts a revoke row (activated=false)', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.access_revoked',
          event_id: 'evt_rev_1',
          member: { email: 'a@x.com' },
          feed: { id: 7 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const write = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(write).toBeDefined()
    // The revoke upsert sets activated=false — assert the literal is in the SQL.
    expect(write!.sql).toContain('false')
    expect(write!.values).toContain(7)
  })

  test('accepts numeric-string feed id', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 'evt_act_2',
          member: { email: 'a@x.com' },
          feed: { id: '99' },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const write = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(write!.values).toContain(99)
  })

  test('incomplete payload (no email) → 200 skipped, no activation write', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: { event: 'feed.activated', event_id: 'evt_x', feed: { id: 5 } },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ skipped: 'incomplete' })
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(false)
  })

  test('incomplete payload (bad feed id) → 200 skipped, no activation write', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 'evt_y',
          member: { email: 'a@x.com' },
          feed: { id: 0 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ skipped: 'incomplete' })
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(false)
  })

  test('unhandled event type → 200 skipped, no writes', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.something_else',
          event_id: 'evt_z',
          member: { email: 'a@x.com' },
          feed: { id: 5 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ skipped: 'unhandled_type' })
    // Nothing to reprocess, so no ledger row is written; no activation either.
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_webhook_events'))).toBe(false)
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(false)
  })

  test('already-recorded event_id → 200 deduped, no activation write', async () => {
    // The dedupe SELECT finds an existing row → already processed.
    nextSqlResult = (sql) =>
      sql.includes('select 1 from sc_webhook_events') ? [{ one: 1 }] : []
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 'evt_dupe',
          member: { email: 'a@x.com' },
          feed: { id: 5 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ deduped: true })
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(false)
  })

  test('missing event_id still processes (upsert is idempotent)', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          member: { email: 'a@x.com' },
          feed: { id: 5 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    // No ledger claim attempted, but the activation write happens.
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_webhook_events'))).toBe(false)
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(true)
  })

  test('audio.downloaded → create-if-absent activation from top-level feed_id', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'audio.downloaded',
          event_id: 555,
          timestamp: '2026-07-16T09:00:00Z',
          member: { email: 'Listener@X.com' },
          feed_id: 77,
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true })
    const write = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(write).toBeDefined()
    // create-if-absent, not the authoritative upsert.
    expect(write!.sql).toContain('on conflict (email, feed_id) do nothing')
    expect(write!.values).toContain('listener@x.com')
    expect(write!.values).toContain(77)
  })

  test('audio.downloaded reads feed_id nested under audio', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'audio.downloaded',
          event_id: 556,
          member: { email: 'a@x.com' },
          audio: { feed_id: 88 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const write = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(write!.values).toContain(88)
  })

  test('integer event_id is stringified for the ledger lookup and deduped', async () => {
    // The dedupe SELECT finds the (stringified) id → already processed.
    nextSqlResult = (sql) =>
      sql.includes('select 1 from sc_webhook_events') ? [{ one: 1 }] : []
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 12345,
          member: { email: 'a@x.com' },
          feed: { id: 5 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ deduped: true })
    const lookup = sqlCalls.find((c) =>
      c.sql.includes('select 1 from sc_webhook_events'),
    )
    expect(lookup!.values).toContain('12345') // string, not number
  })

  test('upsert throws → 500 so SC retries, and the ledger is NOT written', async () => {
    // The activation upsert fails; the dedupe SELECT still returns no row.
    nextSqlResult = (sql) => {
      if (sql.includes('insert into sc_feed_activations')) {
        throw new Error('db unavailable')
      }
      return []
    }
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 'evt_boom',
          member: { email: 'a@x.com' },
          feed: { id: 5 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(500)
    expect(res.__json()).toMatchObject({ error: 'webhook_handler_failed' })
    // Critically: no ledger row, so SC's retry reprocesses rather than dedupes.
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_webhook_events'))).toBe(false)
  })

  test('ledger read error is non-fatal — the event still processes', async () => {
    // The dedupe SELECT throws; the upsert must still run and return 200.
    nextSqlResult = (sql) => {
      if (sql.includes('select 1 from sc_webhook_events')) {
        throw new Error('read timeout')
      }
      return []
    }
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          event: 'feed.activated',
          event_id: 'evt_readfail',
          member: { email: 'a@x.com' },
          feed: { id: 5 },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true })
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(true)
  })
})
