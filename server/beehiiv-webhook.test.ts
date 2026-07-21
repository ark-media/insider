// Unit tests for the inbound Beehiiv webhook at POST /api/beehiiv/webhook.
//
// The webhook gates on a query-string secret (`?key=…`), then upserts /
// deletes a row in beehiiv_subscription based on the event type. We also
// guard against arbitrary email payloads by checking the email is known to
// us (existing mirror row OR Auth0 user). Tests cover:
//   - 401 on missing / wrong key
//   - 405 on non-POST
//   - 400 on invalid JSON
//   - subscription.deleted → row deleted (only when known)
//   - subscription.upgraded → row upserted with has_premium=true (only when known)
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
const WEBHOOK_PATH = '/api/beehiiv/webhook'
const WEBHOOK_SECRET = 'whsec-test-1234567890abcdef'
const PUB_ID = 'pub_test-abc'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: PUB_ID,
  BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER: PUB_ID,
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
}) {
  return makeFakeReq({
    method: opts.method ?? 'POST',
    url: opts.url ?? `${WEBHOOK_PATH}?key=${WEBHOOK_SECRET}`,
    body: opts.rawBody !== undefined ? opts.rawBody : opts.body,
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
  test('subscription.deleted removes local row when reader known', async () => {
    // First SQL call (isKnownReader) returns a row → known.
    nextSqlResult = (sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 'a@x.com',
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_x',
            status: 'active',
            has_premium: false,
            updated_at: new Date().toISOString(),
          },
        ]
      }
      return []
    }
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        body: {
          event_type: 'subscription.deleted',
          data: { id: 'sub_x', email: 'a@x.com' },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(sqlCalls.some((c) => c.sql.includes('delete from beehiiv_subscription'))).toBe(true)
  })

  test('subscription.upgraded upserts with has_premium=true when known', async () => {
    let firstCall = true
    nextSqlResult = (sql) => {
      // isKnownReader's first SELECT returns a row.
      if (firstCall && sql.includes('select') && sql.includes('beehiiv_subscription')) {
        firstCall = false
        return [
          {
            email: 'b@x.com',
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_y',
            status: 'active',
            has_premium: false,
            updated_at: new Date().toISOString(),
          },
        ]
      }
      return []
    }
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        body: {
          event_type: 'subscription.upgraded',
          data: {
            id: 'sub_y',
            email: 'b@x.com',
            status: 'active',
            subscription_tier: 'premium',
            subscription_premium_tier_names: ['Premium'],
          },
        },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const upsert = sqlCalls.find((c) =>
      c.sql.includes('insert into beehiiv_subscription'),
    )
    expect(upsert).toBeDefined()
    // has_premium is the 5th interpolated value in the upsert (see helper).
    expect(upsert!.values).toContain(true)
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
