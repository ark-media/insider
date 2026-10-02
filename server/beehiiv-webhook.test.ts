// Unit tests for the inbound Beehiiv webhook at POST /api/beehiiv/webhook.
//
// The webhook gates on a query-string secret (`?key=…`), then upserts /
// deletes a row in beehiiv_subscription based on the event type. We also
// guard against arbitrary email payloads by checking the email is known to
// us (existing mirror row OR Auth0 user). Tests cover:
//   - 401 on missing / wrong key
//   - 405 on non-POST
//   - 400 on invalid JSON
//   - subscription.* → the reader is re-read from Beehiiv and THAT record is
//     mirrored (only when known); the body is a hint, never written
//   - subscription.deleted confirmed by a 404 → tombstone row, never a delete
//   - unknown reader → no DB writes
//   - DATABASE_URL absent → 200 received, no DB calls (env-clean shape)

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test'
import {
  neonMockModule,
  type SqlCall,
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// Neon mock — captures every tagged-template query so tests can inspect
// what would have been written without a live DB. Configure
// `nextSqlResult` per test to control what reads return.
// ---------------------------------------------------------------------------
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

// Static import AFTER mock.module so the plugin picks up the fake neon.
import { createHmac } from 'node:crypto'
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
const WEBHOOK_PATH = '/api/beehiiv/webhook'
const WEBHOOK_SECRET = 'whsec-test-1234567890abcdef'
const PUB_ID = 'pub_test-abc'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: PUB_ID,
  BEEHIIV_PREMIUM_TIER_ID: 'pt_premium',
  BEEHIIV_WEBHOOK_SECRET: WEBHOOK_SECRET,
  // Distinct DATABASE_URL per test file — see me-newsletters.test.ts for
  // why (getDb caches by url across test files).
  DATABASE_URL: 'postgres://stub-beehiiv-webhook',
}

// Build with a full env (not overrides) — letting tests opt entire keys out
// instead of only overriding values. The webhook gates on secrets/env state,
// so "key removed" is a first-class case we need to express.
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
  headers?: Record<string, string>
}) {
  return makeFakeReq({
    method: opts.method ?? 'POST',
    url: opts.url ?? `${WEBHOOK_PATH}?key=${WEBHOOK_SECRET}`,
    body: opts.rawBody !== undefined ? opts.rawBody : opts.body,
    headers: opts.headers,
  })
}

// ---------------------------------------------------------------------------
// Outbound fetch mock — Auth0 lookups during isKnownReader. Default: no
// upstream calls answered; tests configure per-case behavior.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; method: string }> = []
let fetchHandler: (call: { url: string; method: string }) => Response =
  () => new Response('{}', { status: 500 })

globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : input.toString()
  const method = init?.method ?? 'GET'
  fetchCalls.push({ url, method })
  return fetchHandler({ url, method })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  sqlCalls.length = 0
  fetchCalls = []
  nextSqlResult = () => []
  fetchHandler = () => new Response('{}', { status: 500 })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// ===========================================================================
// Auth + transport guards
// ===========================================================================

describe('webhook auth + transport', () => {
  test('405 on non-POST', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  test('401 when key missing', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ url: WEBHOOK_PATH }), res)
    expect(res.statusCode).toBe(401)
    expect(sqlCalls).toHaveLength(0)
  })

  test('401 when key wrong', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ url: `${WEBHOOK_PATH}?key=wrong` }), res)
    expect(res.statusCode).toBe(401)
  })

  // With a signing secret provisioned, Beehiiv's Svix signature is the gate
  // and the URL key proves nothing: it sits in access logs, a signature over
  // the exact bytes with a five-minute timestamp does not.
  describe('with BEEHIIV_WEBHOOK_SIGNING_SECRET', () => {
    const RAW_KEY = Buffer.from('signing-secret-bytes-for-tests-0123456789')
    const SIGNED_ENV = {
      ...BASE_ENV,
      BEEHIIV_WEBHOOK_SIGNING_SECRET: `whsec_${RAW_KEY.toString('base64')}`,
    }
    const body = JSON.stringify({ event_type: 'subscription.created', uid: 'evt_sig_1', data: {} })
    function signed(rawBody: string, secret: Buffer = RAW_KEY) {
      const ts = String(Math.floor(Date.now() / 1000))
      const sig = createHmac('sha256', secret).update(`msg_1.${ts}.`).update(rawBody).digest('base64')
      return { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }
    }

    test('the correct URL key alone is refused', async () => {
      const handler = buildHandler(SIGNED_ENV)
      const res = makeRes()
      await runHandler(handler, makeReq({ rawBody: body }), res)
      expect(res.statusCode).toBe(401)
      expect(sqlCalls).toHaveLength(0)
    })

    test('a validly signed delivery is accepted, key or no key', async () => {
      const handler = buildHandler(SIGNED_ENV)
      const res = makeRes()
      await runHandler(
        handler,
        makeReq({ url: WEBHOOK_PATH, rawBody: body, headers: signed(body) }),
        res,
      )
      // Past the gate: the known-reader check runs (and fails closed here with
      // no upstream), which is a 200 with nothing written — not a 401.
      expect(res.statusCode).not.toBe(401)
    })

    test('a signature over different bytes, or by another secret, is refused', async () => {
      const handler = buildHandler(SIGNED_ENV)
      const tampered = body.replace('subscription.created', 'subscription.deleted')
      let res = makeRes()
      await runHandler(
        handler,
        makeReq({ url: WEBHOOK_PATH, rawBody: tampered, headers: signed(body) }),
        res,
      )
      expect(res.statusCode).toBe(401)

      res = makeRes()
      await runHandler(
        handler,
        makeReq({ url: WEBHOOK_PATH, rawBody: body, headers: signed(body, Buffer.from('other')) }),
        res,
      )
      expect(res.statusCode).toBe(401)
    })
  })

  test('accepts the secret in the dedicated header without a query string', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        url: WEBHOOK_PATH,
        headers: { 'x-beehiiv-webhook-secret': WEBHOOK_SECRET },
      }),
      res,
    )
    expect(res.statusCode).toBe(400)
  })

  test('does not fall back to the query secret when a header is present but wrong', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        headers: { 'x-beehiiv-webhook-secret': 'wrong' },
      }),
      res,
    )
    expect(res.statusCode).toBe(401)
  })

  test('500 when BEEHIIV_WEBHOOK_SECRET unset', async () => {
    const handler = buildHandler(envWithout('BEEHIIV_WEBHOOK_SECRET'))
    const res = makeRes()
    await runHandler(handler, makeReq({}), res)
    expect(res.statusCode).toBe(500)
  })

  test('400 on invalid JSON', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ rawBody: '{not json' }), res)
    expect(res.statusCode).toBe(400)
  })

  test('200 + skipped writes when DATABASE_URL absent', async () => {
    const handler = buildHandler(envWithout('DATABASE_URL'))
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        body: {
          event_type: 'subscription.upgraded',
          data: { id: 'sub_a', email: 'a@x.com' },
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

describe('webhook event dispatch', () => {
  // A mirror row for the reader, so isKnownReader passes. Every other read
  // returns nothing.
  const knownReader = (email: string) => (sql: string) =>
    sql.includes('select') && sql.includes('from beehiiv_subscription')
      ? [
          {
            email,
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_x',
            status: 'active',
            has_premium: false,
            updated_at: new Date().toISOString(),
          },
        ]
      : []
  // What Beehiiv's by_email read answers. null → 404; a number → that error.
  const beehiivHas = (record: Record<string, unknown> | null | number) => {
    fetchHandler = ({ url }) => {
      if (!url.includes('/subscriptions/by_email/')) return new Response('{}', { status: 500 })
      if (record === null) return new Response('{}', { status: 404 })
      if (typeof record === 'number') return new Response('{"error":"down"}', { status: record })
      return new Response(JSON.stringify({ data: record }), { status: 200 })
    }
  }
  const mirrorUpsert = () =>
    sqlCalls.find((c) => c.sql.includes('insert into beehiiv_subscription'))
  const post = async (body: unknown) => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ body }), res)
    return res
  }

  test('subscription.deleted that Beehiiv confirms (404) leaves a tombstone, not a gap', async () => {
    nextSqlResult = knownReader('a@x.com')
    beehiivHas(null)
    const res = await post({
      event_type: 'subscription.deleted',
      data: { id: 'sub_x', email: 'a@x.com' },
    })
    expect(res.statusCode).toBe(200)
    // The row is kept with a terminal status so the next /api/me does not
    // auto-subscribe the reader again.
    expect(sqlCalls.some((c) => c.sql.includes('delete from beehiiv_subscription'))).toBe(false)
    const upsert = mirrorUpsert()
    expect(upsert).toBeDefined()
    expect(upsert!.values).toContain('deleted')
    expect(upsert!.sql).toContain('has_premium = false')
  })

  test('a forged subscription.deleted for a live reader changes nothing upstream says', async () => {
    nextSqlResult = knownReader('a@x.com')
    beehiivHas({ id: 'sub_x', email: 'a@x.com', status: 'active', subscription_tier: 'premium' })
    const res = await post({
      event_type: 'subscription.deleted',
      data: { id: 'sub_x', email: 'a@x.com' },
    })
    expect(res.statusCode).toBe(200)
    const upsert = mirrorUpsert()
    expect(upsert).toBeDefined()
    // [email, publication, id, status, has_premium] — Beehiiv's record.
    expect(upsert!.values.slice(0, 5)).toEqual(['a@x.com', PUB_ID, 'sub_x', 'active', true])
  })

  test('subscription.upgraded mirrors has_premium from Beehiiv, not from the body', async () => {
    nextSqlResult = knownReader('b@x.com')
    // The body claims premium; Beehiiv says the reader is free.
    beehiivHas({ id: 'sub_y', email: 'b@x.com', status: 'active', subscription_tier: 'free' })
    const res = await post({
      event_type: 'subscription.upgraded',
      data: {
        id: 'sub_y',
        email: 'b@x.com',
        status: 'active',
        subscription_tier: 'premium',
        subscription_premium_tier_names: ['Premium'],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(fetchCalls.some((c) => c.url.includes('/subscriptions/by_email/b%40x.com'))).toBe(true)
    const upsert = mirrorUpsert()
    expect(upsert).toBeDefined()
    expect(upsert!.values.slice(0, 5)).toEqual(['b@x.com', PUB_ID, 'sub_y', 'active', false])
  })

  test('a genuine upgrade lands has_premium=true, read back from Beehiiv', async () => {
    nextSqlResult = knownReader('b@x.com')
    beehiivHas({ id: 'sub_y', email: 'b@x.com', status: 'active', subscription_tier: 'premium' })
    const res = await post({
      event_type: 'subscription.upgraded',
      data: { id: 'sub_y', email: 'b@x.com', subscription_tier: 'premium' },
    })
    expect(res.statusCode).toBe(200)
    expect(mirrorUpsert()!.values[4]).toBe(true)
  })

  test('a non-delete event for a reader Beehiiv has no record of writes nothing', async () => {
    nextSqlResult = knownReader('b@x.com')
    beehiivHas(null)
    const res = await post({
      event_type: 'subscription.created',
      data: { id: 'sub_y', email: 'b@x.com', subscription_tier: 'premium' },
    })
    expect(res.statusCode).toBe(200)
    expect(mirrorUpsert()).toBeUndefined()
  })

  test('a failed re-read writes nothing and answers 500 so Beehiiv redelivers', async () => {
    nextSqlResult = knownReader('b@x.com')
    beehiivHas(503)
    const res = await post({
      uid: 'evt_retry',
      event_type: 'subscription.upgraded',
      data: { id: 'sub_y', email: 'b@x.com', subscription_tier: 'premium' },
    })
    expect(res.statusCode).toBe(500)
    expect(mirrorUpsert()).toBeUndefined()
    // Not recorded as processed, so the redelivery is not deduped away.
    expect(sqlCalls.some((c) => c.sql.includes('insert into beehiiv_webhook_events'))).toBe(false)
  })

  // Replay: the only thing a delivery carries that identifies it is `uid`, and
  // the ledger is keyed on it. A delivery already processed is acknowledged and
  // does nothing — and is recorded only AFTER its handler succeeded, so a
  // failed one is still Beehiiv's to retry.
  test('a replayed delivery (uid already in the ledger) is acknowledged and changes nothing', async () => {
    nextSqlResult = (sql) =>
      sql.includes('from beehiiv_webhook_events') ? [{ '?column?': 1 }] : []
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          uid: 'evt_replayed',
          event_type: 'subscription.deleted',
          data: { id: 'sub_x', email: 'a@x.com' },
        },
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ received: true, deduped: true })
    expect(sqlCalls).toHaveLength(1)
    expect(sqlCalls.some((c) => c.sql.includes('beehiiv_subscription'))).toBe(false)
  })

  test('a first delivery is written to the ledger under its uid once it has been handled', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({
        body: {
          uid: 'evt_first',
          event_type: 'subscription.deleted',
          data: { id: 'sub_x', email: 'a@x.com' },
        },
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    const ledger = sqlCalls.filter((c) => c.sql.includes('insert into beehiiv_webhook_events'))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.values).toContain('evt_first')
    // After every other statement, never before.
    expect(sqlCalls.at(-1)).toBe(ledger[0]!)
  })

  test('unknown reader → no writes (mirror miss + Auth0 miss)', async () => {
    // No local row, Auth0 returns no user.
    nextSqlResult = () => []
    fetchHandler = ({ url }) => {
      if (url.endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 't', expires_in: 3600 }),
          { status: 200 },
        )
      }
      if (url.includes('/users-by-email')) {
        return new Response('[]', { status: 200 })
      }
      return new Response('{}', { status: 500 })
    }
    const env: Record<string, string> = {
      ...BASE_ENV,
      AUTH0_MANAGEMENT_CLIENT_ID: 'cid',
      AUTH0_MANAGEMENT_CLIENT_SECRET: 'csec',
      AUTH0_TENANT_DOMAIN: 'https://tenant.us.auth0.com',
    }
    const handler = buildHandler(env)
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        body: {
          event_type: 'subscription.upgraded',
          data: { id: 'sub_z', email: 'unknown@x.com' },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    // Only the initial SELECT for isKnownReader ran — no upsert or delete.
    expect(sqlCalls.some((c) => c.sql.includes('insert into beehiiv_subscription'))).toBe(false)
    expect(sqlCalls.some((c) => c.sql.includes('delete from beehiiv_subscription'))).toBe(false)
  })

  test('payload without email or id is no-op', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        body: {
          event_type: 'subscription.upgraded',
          data: { status: 'active' }, // no id, no email
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(sqlCalls).toHaveLength(0)
  })
})

// Small helper used above — returns BASE_ENV with one key dropped, to model
// "env var unset" without mutating the shared constant.
function envWithout(key: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(BASE_ENV)) {
    if (k !== key) out[k] = BASE_ENV[k]
  }
  return out
}
