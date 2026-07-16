// Unit tests for the inbound Supporting Cast webhook at POST /api/sc/webhook.
//
// The webhook gates on a query-string secret (`?key=…`), claims event_id in an
// idempotency ledger, then upserts sc_feed_activations based on the event type
// (feed.activated / feed.access_revoked). Tests cover:
//   - 405 on non-POST
//   - 401 on missing / wrong key
//   - 500 when SC_WEBHOOK_SECRET unset
//   - 400 on invalid JSON
//   - DATABASE_URL absent → 200 received, no DB calls
//   - feed.activated → activation upsert (activated=true)
//   - feed.access_revoked → revoke upsert (activated=false)
//   - incomplete payload (no email / no feed id) → 200 skipped, no writes
//   - unhandled event type → 200 skipped, ledger claimed but no activation write
//   - duplicate event_id → 200 deduped, no activation write

import {
  describe,
  test,
  expect,
  beforeEach,
  mock,
} from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { silenceExpectedConsole } from './test-utils'

// ---------------------------------------------------------------------------
// Neon mock — captures every tagged-template query. `nextSqlResult` controls
// what reads (the idempotency INSERT ... RETURNING) return per test.
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
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

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
  const handlers = new Map<string, Middleware>()
  const fakeServer = {
    middlewares: {
      use(path: string, handler: Middleware) {
        handlers.set(path, handler)
      },
    },
  }
  const plugin = devApiPlugin(env)
  ;(plugin.configureServer as unknown as (s: unknown) => void)(fakeServer)
  const handler = handlers.get(WEBHOOK_PATH)
  if (!handler) throw new Error(`handler not registered for ${WEBHOOK_PATH}`)
  return handler
}

// ---------------------------------------------------------------------------
// Fake req/res
// ---------------------------------------------------------------------------
function makeReq(opts: {
  method?: string
  url?: string
  body?: unknown
  rawBody?: string
}): IncomingMessage {
  const raw =
    opts.rawBody !== undefined
      ? Buffer.from(opts.rawBody, 'utf8')
      : opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body), 'utf8')
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'POST'
  stream.url = opts.url ?? `${WEBHOOK_PATH}?key=${WEBHOOK_SECRET}`
  stream.headers = { 'content-type': 'application/json' }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
}

function makeRes(): FakeRes {
  let body = ''
  let statusCode = 200
  let ended = false
  const headers: Record<string, string> = {}
  const res = {
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
  } as unknown as FakeRes
  return res
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

// The idempotency claim is `insert ... on conflict do nothing returning id`.
// Default: return a row (claim succeeds, first delivery).
function claimSucceeds(sql: string): unknown[] {
  return sql.includes('insert into sc_webhook_events') ? [{ id: 'x' }] : []
}

beforeEach(() => {
  sqlCalls.length = 0
  nextSqlResult = claimSucceeds
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

  test('unhandled event type → 200 skipped, ledger claimed but no activation write', async () => {
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
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_webhook_events'))).toBe(true)
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(false)
  })

  test('duplicate event_id → 200 deduped, no activation write', async () => {
    // Claim INSERT returns no row → already processed.
    nextSqlResult = () => []
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

  test('integer event_id is stringified for the ledger and deduped', async () => {
    // Claim returns no row → treated as already processed.
    nextSqlResult = () => []
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
    const claim = sqlCalls.find((c) => c.sql.includes('insert into sc_webhook_events'))
    expect(claim!.values).toContain('12345') // string, not number
  })
})
