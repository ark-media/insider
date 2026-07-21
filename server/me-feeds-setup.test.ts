// Unit tests for the server-side "feed set up" optimistic marker that replaced
// the client-side localStorage record:
//   - POST /api/me/feeds/setup writes a pending marker (recordFeedsPending)
//   - GET /api/me surfaces `activated` / `pending` on each feed (getSetupStates)

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import {
  neonMockModule,
  type SqlCall,
  AUTH0_TEST_JWKS_URL,
  createDevApiHarness,
  jwksResponse,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  signAuth0TestToken,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// Neon mock — captures sql calls and lets each test stage a result.
// ---------------------------------------------------------------------------
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

// Static imports AFTER mock.module so the plugin picks up the fake neon.
import { devApiPlugin } from './dev-api'
import { signCheckoutToken, signSessionToken } from './lib/session'
import { CHECKOUT_COOKIE_NAME, SESSION_COOKIE_NAME } from './lib/cookies'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-sc-key',
  CHECKOUT_SESSION_SECRET: 'checkout-secret-for-tests-0123456789',
  SESSION_SECRET: 'session-secret-for-tests-32-chars__',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test',
  BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER: 'pub_test',
  // Distinct URL per test file keeps getDb()'s cached neon closure isolated.
  DATABASE_URL: 'postgres://stub-me-feeds-setup-test',
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function buildHandler(path: string, env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(path)
}

function makeReq(opts: {
  path: string
  method?: string
  bearer?: string
  cookie?: string
  origin?: string
  body?: unknown
}): IncomingMessage {
  const payload = opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body))
  const stream = Readable.from([payload]) as unknown as Omit<
    IncomingMessage,
    'socket'
  > & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'GET'
  stream.url = opts.path
  stream.headers = { 'content-type': 'application/json' }
  if (opts.bearer) stream.headers['authorization'] = `Bearer ${opts.bearer}`
  if (opts.cookie) stream.headers['cookie'] = opts.cookie
  if (opts.origin) stream.headers['origin'] = opts.origin
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

// ---------------------------------------------------------------------------
// fetch mock — JWKS + Simplecast (Beehiiv not exercised on the subscriber path).
// ---------------------------------------------------------------------------
let scUserByEmail: Map<string, { id: number; email: string } | null> = new Map()
let scFeedsByUserId: Map<number, { id: number; name: string; url: string }[]> = new Map()

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url === AUTH0_TEST_JWKS_URL) return jwksResponse()
  if (url.endsWith('/users/search') && init?.method === 'POST') {
    const body = init.body ? (JSON.parse(init.body as string) as { email: string }) : { email: '' }
    const user = scUserByEmail.get(body.email)
    return new Response(JSON.stringify({ users: user ? [user] : [] }), { status: 200 })
  }
  const feedsMatch = url.match(/\/users\/(\d+)\/feeds$/)
  if (feedsMatch) {
    const feeds = scFeedsByUserId.get(Number(feedsMatch[1]))
    if (feeds === undefined) return new Response('{"error":"not_found"}', { status: 404 })
    return new Response(JSON.stringify({ feeds }), { status: 200 })
  }
  return new Response('{}', { status: 500 })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  scUserByEmail = new Map()
  scFeedsByUserId = new Map()
  sqlCalls.length = 0
  nextSqlResult = () => []
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// ===========================================================================
// POST /api/me/feeds/setup
// ===========================================================================
describe('POST /api/me/feeds/setup', () => {
  const PATH = '/api/me/feeds/setup'

  test('405 on non-POST', async () => {
    const res = makeRes()
    await runHandler(buildHandler(PATH), makeReq({ path: PATH, method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  test('403 on cross-origin post', async () => {
    const token = await signSessionToken({ email: 'm@x.com', roles: [] }, BASE_ENV)
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        origin: 'https://evil.example',
        body: { feed_ids: [1] },
      }),
      res,
    )
    expect(res.statusCode).toBe(403)
    expect((res.__json() as { error: string }).error).toBe('bad_origin')
  })

  test('401 when no session', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, method: 'POST', body: { feed_ids: [1] } }),
      res,
    )
    expect(res.statusCode).toBe(401)
  })

  test('400 when feed_ids missing or empty', async () => {
    const token = await signSessionToken({ email: 'm@x.com', roles: [] }, BASE_ENV)
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, method: 'POST', cookie: `${SESSION_COOKIE_NAME}=${token}`, body: {} }),
      res,
    )
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toBe('no_feed_ids')
  })

  test('200 + persists pending marker for a session cookie', async () => {
    const token = await signSessionToken({ email: 'Member@X.com', roles: [] }, BASE_ENV)
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        body: { feed_ids: [1, 2, 3] },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
    const write = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(write).toBeDefined()
    // The unnest insert binds two array params: emails then feed ids.
    const [emails, ids] = (write?.values ?? []) as [string[], number[]]
    // pending_at is stamped; email is normalized (lowercased) before the write.
    expect(write?.sql.includes('pending_at')).toBe(true)
    expect(emails).toEqual(['member@x.com', 'member@x.com', 'member@x.com'])
    expect(ids).toEqual([1, 2, 3])
  })

  test('drops non-positive / non-integer feed ids before writing', async () => {
    const token = await signSessionToken({ email: 'm@x.com', roles: [] }, BASE_ENV)
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        body: { feed_ids: [0, -4, 2.5, 'x', 7] },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const write = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    // Only the single valid id (7) reaches the write; 0, -4, 2.5, 'x' dropped.
    const ids = ((write?.values ?? [])[1] ?? []) as number[]
    expect(ids).toEqual([7])
  })

  test('checkout cookie (just-paid member) also authorizes the write', async () => {
    const token = await signCheckoutToken('fresh@x.com', BASE_ENV)
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${CHECKOUT_COOKIE_NAME}=${token}`,
        body: { feed_ids: [5] },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
  })

  test('DATABASE_URL unset → 200 ack, no write attempted', async () => {
    const env = { ...BASE_ENV }
    delete env.DATABASE_URL
    const token = await signSessionToken({ email: 'm@x.com', roles: [] }, env)
    const res = makeRes()
    await runHandler(
      buildHandler(PATH, env),
      makeReq({ path: PATH, method: 'POST', cookie: `${SESSION_COOKIE_NAME}=${token}`, body: { feed_ids: [1] } }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(sqlCalls.some((c) => c.sql.includes('insert into sc_feed_activations'))).toBe(false)
  })

  test('500 when the pending write fails', async () => {
    const token = await signSessionToken({ email: 'writefail@x.com', roles: [] }, BASE_ENV)
    nextSqlResult = (sql) => {
      if (sql.includes('insert into sc_feed_activations')) throw new Error('db down')
      return []
    }
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        body: { feed_ids: [1] },
      }),
      res,
    )
    expect(res.statusCode).toBe(500)
    expect((res.__json() as { error: string }).error).toBe('pending_write_failed')
  })

  test('rate-limits with 429 once the burst capacity is spent', async () => {
    // Unique email so this test's bucket doesn't collide with the others
    // (the limiter is module-scoped and persists across handler builds).
    const token = await signSessionToken({ email: 'burst@x.com', roles: [] }, BASE_ENV)
    const post = () =>
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        body: { feed_ids: [1] },
      })
    // Capacity is 20; drain it.
    for (let i = 0; i < 20; i++) {
      const ok = makeRes()
      await runHandler(buildHandler(PATH), post(), ok)
      expect(ok.statusCode).toBe(200)
    }
    const limited = makeRes()
    await runHandler(buildHandler(PATH), post(), limited)
    expect(limited.statusCode).toBe(429)
    expect((limited.__json() as { error: string }).error).toBe('too_many_requests')
    expect(limited.getHeader('retry-after')).toBeDefined()
  })
})

// ===========================================================================
// GET /api/me — feed setup-state enrichment
// ===========================================================================
describe('GET /api/me feed setup enrichment', () => {
  const PATH = '/api/me'

  test('surfaces activated + pending flags per feed', async () => {
    scUserByEmail.set('paid@x.com', { id: 42, email: 'paid@x.com' })
    scFeedsByUserId.set(42, [
      { id: 1, name: 'Confirmed', url: 'https://x/1.xml' },
      { id: 2, name: 'Pending', url: 'https://x/2.xml' },
      { id: 3, name: 'Untouched', url: 'https://x/3.xml' },
    ])
    // The getSetupStates read: feed 1 confirmed, feed 2 pending, feed 3 absent.
    nextSqlResult = (sql) =>
      sql.includes('from sc_feed_activations') && sql.includes('pending_at')
        ? [
            { feed_id: 1, activated: true, activated_at: '2026-01-02T00:00:00Z', pending_at: null, revoked_at: null },
            { feed_id: 2, activated: false, activated_at: null, pending_at: '2026-01-03T00:00:00Z', revoked_at: null },
          ]
        : []

    const token = await signAuth0TestToken({ email: 'paid@x.com' })
    const res = makeRes()
    await runHandler(buildHandler(PATH), makeReq({ path: PATH, bearer: token }), res)

    expect(res.statusCode).toBe(200)
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    expect(feeds[0]).toMatchObject({ id: 1, activated: true, pending: false })
    expect(feeds[1]).toMatchObject({ id: 2, activated: false, pending: true })
    // Feed 3 has no row → no activation fields added.
    expect(feeds[2]).toEqual({ id: 3, name: 'Untouched', url: 'https://x/3.xml' })
  })

  test('a revoked row with a stale pending marker is not treated as set up', async () => {
    scUserByEmail.set('paid@x.com', { id: 42, email: 'paid@x.com' })
    scFeedsByUserId.set(42, [{ id: 9, name: 'Revoked', url: 'https://x/9.xml' }])
    nextSqlResult = (sql) =>
      sql.includes('from sc_feed_activations') && sql.includes('pending_at')
        ? [{ feed_id: 9, activated: false, activated_at: null, pending_at: '2026-01-03T00:00:00Z', revoked_at: '2026-01-04T00:00:00Z' }]
        : []

    const token = await signAuth0TestToken({ email: 'paid@x.com' })
    const res = makeRes()
    await runHandler(buildHandler(PATH), makeReq({ path: PATH, bearer: token }), res)

    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    // Neither activated nor pending → untouched, so the hub shows "not set up".
    expect(feeds[0]).toEqual({ id: 9, name: 'Revoked', url: 'https://x/9.xml' })
  })

  test('enrichment DB error is soft — feeds returned unenriched, still 200', async () => {
    scUserByEmail.set('paid@x.com', { id: 42, email: 'paid@x.com' })
    scFeedsByUserId.set(42, [{ id: 1, name: 'A', url: 'https://x/1.xml' }])
    // The getSetupStates read throws — a mirror outage must not break /api/me.
    nextSqlResult = (sql) => {
      if (sql.includes('from sc_feed_activations')) throw new Error('mirror down')
      return []
    }

    const token = await signAuth0TestToken({ email: 'paid@x.com' })
    const res = makeRes()
    await runHandler(buildHandler(PATH), makeReq({ path: PATH, bearer: token }), res)

    expect(res.statusCode).toBe(200)
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    // No activation fields added — degrades to "nothing set up yet".
    expect(feeds[0]).toEqual({ id: 1, name: 'A', url: 'https://x/1.xml' })
  })
})
