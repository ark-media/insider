// Unit tests for the server-side "feed set up" optimistic marker that replaced
// the client-side localStorage record:
//   - POST /api/me/feeds/setup writes a pending marker (recordFeedsPending)
//   - GET /api/me surfaces `activated` / `pending` on each feed (getSetupStates)
//
// Everything here keys on the SHOW id. Beehiiv's feed token rotates on reissue,
// so keying the marker on it would silently reset a member's setup state.

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
let membershipRows: unknown[] = []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) =>
    merged.includes('from membership') ? membershipRows : nextSqlResult(merged),
  ),
)

function arkPlusRow(sub: string): Record<string, unknown> {
  return {
    auth0_sub: sub,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    tier: 'ark-plus',
    status: 'active',
    plan: 'monthly',
    amount_cents: 599,
    current_period_end: null,
    cancel_at: null,
    ark_plus_gift_expires_at: null,
    circle_gift_expires_at: null,
  }
}

// Static imports AFTER mock.module so the plugin picks up the fake neon.
import { devApiPlugin } from './dev-api'
import { clearPrivateFeedCache } from './lib/beehiiv-feeds'
import { signCheckoutToken, signSessionToken } from './lib/session'
import { CHECKOUT_COOKIE_NAME, SESSION_COOKIE_NAME } from './lib/cookies'

const SHOW_ID = 'pod_show-a'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-sc-key',
  CHECKOUT_SESSION_SECRET: 'checkout-secret-for-tests-0123456789',
  SESSION_SECRET: 'session-secret-for-tests-32-chars__',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test',
  BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER: 'pub_test',
  BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK: SHOW_ID,
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
// fetch mock — JWKS + the Beehiiv private feed.
// ---------------------------------------------------------------------------
let hasPrivateFeed = false

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url === AUTH0_TEST_JWKS_URL) return jwksResponse()
  if (url.includes('/private_feeds/by_email/')) {
    if (!hasPrivateFeed) return new Response('{"errors":[]}', { status: 404 })
    return new Response(
      JSON.stringify({
        data: {
          id: 'pod_feed_rotating',
          url: 'https://rss.beehiiv.com/podcasts/x/private/tok.xml',
          protocol_links: {},
          created: 1788982716,
          activated: null,
          revoked: null,
          expires: null,
          show: { id: SHOW_ID, title: 'Show A' },
        },
      }),
      { status: 200 },
    )
  }
  return new Response('{}', { status: 500 })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  hasPrivateFeed = false
  membershipRows = []
  clearPrivateFeedCache()
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
        body: { feed_ids: ['pod_a'] },
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
      makeReq({ path: PATH, method: 'POST', body: { feed_ids: ['pod_a'] } }),
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
        body: { feed_ids: ['pod_a', 'pod_b', 'pod_c'] },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
    const write = sqlCalls.find((c) => c.sql.includes('insert into beehiiv_feed_activations'))
    expect(write).toBeDefined()
    // The unnest insert binds two array params: emails then show ids.
    const [emails, ids] = (write?.values ?? []) as [string[], string[]]
    // pending_at is stamped; email is normalized (lowercased) before the write.
    expect(write?.sql.includes('pending_at')).toBe(true)
    expect(emails).toEqual(['member@x.com', 'member@x.com', 'member@x.com'])
    expect(ids).toEqual(['pod_a', 'pod_b', 'pod_c'])
  })

  test('drops non-string / empty / overlong show ids before writing', async () => {
    const token = await signSessionToken({ email: 'm@x.com', roles: [] }, BASE_ENV)
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        body: { feed_ids: [0, '', null, 'x'.repeat(65), 'pod_ok'] },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const write = sqlCalls.find((c) => c.sql.includes('insert into beehiiv_feed_activations'))
    const ids = ((write?.values ?? [])[1] ?? []) as string[]
    expect(ids).toEqual(['pod_ok'])
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
        body: { feed_ids: ['pod_a'] },
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
      makeReq({ path: PATH, method: 'POST', cookie: `${SESSION_COOKIE_NAME}=${token}`, body: { feed_ids: ['pod_a'] } }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(sqlCalls.some((c) => c.sql.includes('insert into beehiiv_feed_activations'))).toBe(false)
  })

  test('500 when the pending write fails', async () => {
    const token = await signSessionToken({ email: 'writefail@x.com', roles: [] }, BASE_ENV)
    nextSqlResult = (sql) => {
      if (sql.includes('insert into beehiiv_feed_activations')) throw new Error('db down')
      return []
    }
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        body: { feed_ids: ['pod_a'] },
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
        body: { feed_ids: ['pod_a'] },
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

  // A member with a live feed. Enrichment is what the mirror adds on top.
  async function getMe(email: string) {
    membershipRows = [arkPlusRow(`auth0|${email}`)]
    hasPrivateFeed = true
    const token = await signAuth0TestToken({ email })
    const res = makeRes()
    await runHandler(buildHandler(PATH), makeReq({ path: PATH, bearer: token }), res)
    return res
  }

  function stageStates(rows: unknown[]) {
    nextSqlResult = (sql) =>
      sql.includes('from beehiiv_feed_activations') && sql.includes('pending_at')
        ? rows
        : []
  }

  test('surfaces a confirmed activation', async () => {
    stageStates([
      {
        show_id: SHOW_ID,
        activated: true,
        activated_at: '2026-01-02T00:00:00Z',
        pending_at: null,
        revoked_at: null,
      },
    ])
    const res = await getMe('confirmed@x.com')
    expect(res.statusCode).toBe(200)
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    expect(feeds[0]).toMatchObject({
      id: SHOW_ID,
      activated: true,
      activated_at: '2026-01-02T00:00:00Z',
      pending: false,
    })
  })

  test('surfaces the optimistic pending marker', async () => {
    stageStates([
      {
        show_id: SHOW_ID,
        activated: false,
        activated_at: null,
        pending_at: '2026-01-03T00:00:00Z',
        revoked_at: null,
      },
    ])
    const res = await getMe('pendingmark@x.com')
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    expect(feeds[0]).toMatchObject({ activated: false, pending: true })
  })

  test('a show with no mirror row carries no activation fields', async () => {
    stageStates([])
    const res = await getMe('untouched@x.com')
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    expect(feeds[0].activated).toBeUndefined()
    expect(feeds[0].pending).toBeUndefined()
  })

  test('a revoked row with a stale pending marker is not treated as set up', async () => {
    stageStates([
      {
        show_id: SHOW_ID,
        activated: false,
        activated_at: null,
        pending_at: '2026-01-03T00:00:00Z',
        revoked_at: '2026-01-04T00:00:00Z',
      },
    ])
    const res = await getMe('revoked@x.com')
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    // Neither activated nor pending → the page shows "not set up".
    expect(feeds[0].activated).toBeUndefined()
    expect(feeds[0].pending).toBeUndefined()
  })

  test('enrichment DB error is soft — the live feed is still returned, still 200', async () => {
    // A mirror outage must degrade to "not set up yet", never break /api/me.
    nextSqlResult = (sql) => {
      if (sql.includes('from beehiiv_feed_activations')) throw new Error('mirror down')
      return []
    }
    const res = await getMe('mirrordown@x.com')
    expect(res.statusCode).toBe(200)
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    expect(feeds[0].id).toBe(SHOW_ID)
    expect(feeds[0].activated).toBeUndefined()
  })
})
