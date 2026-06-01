// Unit tests for GET /api/me.
//
// Covers the post-free-account world where /api/me has two healthy outcomes
// instead of one:
//   - SC user found → 200 { tier: 'ark-plus-member', feeds }
//   - SC user not found AND the session is an Auth0 bearer whose tier claim
//     is not 'ark-plus-member' → 200 { tier: 'free', feeds: [] }
// The legacy 401 stays only for the checkout-cookie path (issued post-payment,
// so a missing SC user there is a provisioning gap, not a free user) and for
// stale 'ark-plus-member' JWTs whose SC record vanished.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AUTH0_TEST_JWKS_URL,
  getAuth0TestKeys,
  signAuth0TestToken,
  silenceExpectedConsole,
} from './test-utils'

// ---------------------------------------------------------------------------
// Neon mock — captures sql calls and lets each test stage a result.
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

// Static imports AFTER mock.module so the plugin picks up the fake neon.
import { devApiPlugin } from './dev-api'
import { signCheckoutToken } from './lib/session'
import { CHECKOUT_COOKIE_NAME } from './lib/cookies'

const signAuth0Token = signAuth0TestToken

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

const PATH = '/api/me'
const PUB_ID = 'pub_test-me'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-sc-key',
  CHECKOUT_SESSION_SECRET: 'checkout-secret-for-tests',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: PUB_ID,
  BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER: PUB_ID,
  // getDb() caches the neon() client by URL across the process; distinct URL
  // per test file keeps each file's mocked sql closure isolated.
  DATABASE_URL: 'postgres://stub-me-test',
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
  const handler = handlers.get(PATH)
  if (!handler) throw new Error(`handler not registered for ${PATH}`)
  return handler
}

// ---------------------------------------------------------------------------
// Fake req/res
// ---------------------------------------------------------------------------
function makeReq(opts: {
  method?: string
  bearer?: string
  cookie?: string
}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as Omit<
    IncomingMessage,
    'socket'
  > & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'GET'
  stream.url = PATH
  stream.headers = { 'content-type': 'application/json' }
  if (opts.bearer) stream.headers['authorization'] = `Bearer ${opts.bearer}`
  if (opts.cookie) stream.headers['cookie'] = opts.cookie
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
    ;(res as unknown as { end: typeof origEnd }).end = ((
      chunk?: string | Buffer,
    ) => {
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
// fetch mock — serves JWKS, Simplecast, and Beehiiv.
// ---------------------------------------------------------------------------
type ScUserStub = { id: number; email: string } | null
type ScFeedsStub = { id: number; name: string; url: string }[]
type BeehiivCall = { url: string; method: string; body: unknown }

let scUserByEmail: Map<string, ScUserStub> = new Map()
let scFeedsByUserId: Map<number, ScFeedsStub> = new Map()
let scThrowOnSearch = false
let beehiivCalls: BeehiivCall[] = []
let beehiivHandler: (call: BeehiivCall) => Response = () =>
  new Response('{}', { status: 404 })

const originalFetch = globalThis.fetch
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : input.toString()

  // JWKS endpoint (jose.createRemoteJWKSet).
  if (url === AUTH0_TEST_JWKS_URL) {
    const { publicJwk } = await getAuth0TestKeys()
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Simplecast user search.
  if (url.endsWith('/users/search') && init?.method === 'POST') {
    if (scThrowOnSearch) {
      return new Response('{"error":"upstream"}', { status: 500 })
    }
    const body = init.body ? (JSON.parse(init.body as string) as { email: string }) : { email: '' }
    const user = scUserByEmail.get(body.email)
    return new Response(JSON.stringify({ users: user ? [user] : [] }), {
      status: 200,
    })
  }

  // Simplecast feeds for a user.
  const feedsMatch = url.match(/\/users\/(\d+)\/feeds$/)
  if (feedsMatch) {
    const userId = Number(feedsMatch[1])
    const feeds = scFeedsByUserId.get(userId)
    if (feeds === undefined) {
      return new Response('{"error":"not_found"}', { status: 404 })
    }
    return new Response(JSON.stringify({ feeds }), { status: 200 })
  }

  // Beehiiv — defer to per-test handler so tests can stage create/lookup
  // outcomes and assert which endpoints were hit.
  if (url.includes('api.beehiiv.com')) {
    let parsed: unknown
    if (init?.body && typeof init.body === 'string') {
      try { parsed = JSON.parse(init.body) } catch { parsed = init.body }
    }
    const call: BeehiivCall = { url, method: init?.method ?? 'GET', body: parsed }
    beehiivCalls.push(call)
    return beehiivHandler(call)
  }

  return new Response('{}', { status: 500 })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  scUserByEmail = new Map()
  scFeedsByUserId = new Map()
  scThrowOnSearch = false
  sqlCalls.length = 0
  nextSqlResult = () => []
  beehiivCalls = []
  beehiivHandler = () => new Response('{}', { status: 404 })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// ===========================================================================
// Auth + transport
// ===========================================================================

describe('GET /api/me auth', () => {
  test('401 when no session at all', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({}), res)
    expect(res.statusCode).toBe(401)
    expect((res.__json() as { error: string }).error).toBe('unauthenticated')
  })

  test('401 when bearer fails verification', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: 'not-a-jwt' }), res)
    expect(res.statusCode).toBe(401)
  })
})

// ===========================================================================
// Auth0 bearer → tier resolution
// ===========================================================================

describe('GET /api/me with Auth0 bearer', () => {
  test('tier=free claim AND no SC record → 200 free shape', async () => {
    const token = await signAuth0Token({ email: 'free@x.com', tier: 'free' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'free@x.com',
      tier: 'free',
      feeds: [],
    })
  })

  test('tier=subscriber claim AND SC record found → 200 subscriber shape with feeds', async () => {
    scUserByEmail.set('paid@x.com', { id: 42, email: 'paid@x.com' })
    scFeedsByUserId.set(42, [
      { id: 1, name: 'Private feed', url: 'https://example.com/feed.xml' },
    ])
    const token = await signAuth0Token({ email: 'paid@x.com', tier: 'ark-plus-member' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'paid@x.com',
      tier: 'ark-plus-member',
      feeds: [
        { id: 1, name: 'Private feed', url: 'https://example.com/feed.xml' },
      ],
    })
  })

  test('stale tier=free JWT but SC user exists → 200 subscriber (SC presence wins)', async () => {
    // Simulates a recently-upgraded user whose access token still carries the
    // pre-upgrade 'free' claim. Without this fallback they'd lose Circle /
    // private-feed access until their next token refresh.
    scUserByEmail.set('upgraded@x.com', { id: 7, email: 'upgraded@x.com' })
    scFeedsByUserId.set(7, [])
    const token = await signAuth0Token({ email: 'upgraded@x.com', tier: 'free' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'upgraded@x.com',
      tier: 'ark-plus-member',
      feeds: [],
    })
  })

  test('tier=subscriber claim but SC user missing → 401 (legacy contract)', async () => {
    // A 'ark-plus-member' claim with no SC record is a real inconsistency, not a
    // free user. Keep the explicit 401 so the client surfaces an error
    // instead of silently downgrading the dashboard.
    const token = await signAuth0Token({ email: 'gone@x.com', tier: 'ark-plus-member' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(401)
    expect((res.__json() as { error: string }).error).toBe('membership_not_found')
  })

  test('no tier claim AND no SC user → 200 free (safety net for missing Action)', async () => {
    const token = await signAuth0Token({ email: 'unknown-tier@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'unknown-tier@x.com',
      tier: 'free',
      feeds: [],
    })
  })

  test('SC feeds 404 is tolerated; returns subscriber with empty feeds', async () => {
    scUserByEmail.set('newpaid@x.com', { id: 100, email: 'newpaid@x.com' })
    // scFeedsByUserId intentionally not set → mock returns 404.
    const token = await signAuth0Token({ email: 'newpaid@x.com', tier: 'ark-plus-member' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'newpaid@x.com',
      tier: 'ark-plus-member',
      feeds: [],
    })
  })

  test('SC upstream error surfaces as 5xx, not silent free fallback', async () => {
    scThrowOnSearch = true
    const token = await signAuth0Token({ email: 'oops@x.com', tier: 'free' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    // 500 from SC propagates as the surfaced status.
    expect(res.statusCode).toBe(500)
    expect((res.__json() as { error: string }).error).toBe('membership_lookup_failed')
  })
})

// ===========================================================================
// Checkout-cookie session → never falls back to free
// ===========================================================================

describe('GET /api/me with checkout-cookie session', () => {
  test('checkout cookie + SC user found → 200 subscriber', async () => {
    scUserByEmail.set('fresh@x.com', { id: 11, email: 'fresh@x.com' })
    scFeedsByUserId.set(11, [])
    const token = await signCheckoutToken('fresh@x.com', BASE_ENV)
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({ cookie: `${CHECKOUT_COOKIE_NAME}=${token}` }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'fresh@x.com',
      tier: 'ark-plus-member',
      feeds: [],
    })
  })

  test('checkout cookie + SC user missing → 401 (provisioning gap, NOT free fallback)', async () => {
    // The checkout cookie is only issued after a successful Stripe payment,
    // so a missing SC user here means provisioning hasn't finished — never a
    // legitimate "free user" state. Must stay 401.
    const token = await signCheckoutToken('newpay@x.com', BASE_ENV)
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({ cookie: `${CHECKOUT_COOKIE_NAME}=${token}` }),
      res,
    )
    expect(res.statusCode).toBe(401)
    expect((res.__json() as { error: string }).error).toBe('membership_not_found')
  })

  test('checkout token as Bearer (not cookie) also resolves', async () => {
    scUserByEmail.set('viabearer@x.com', { id: 22, email: 'viabearer@x.com' })
    scFeedsByUserId.set(22, [])
    const token = await signCheckoutToken('viabearer@x.com', BASE_ENV)
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { tier: string }).tier).toBe('ark-plus-member')
  })
})

// ===========================================================================
// First-login auto-subscribe to the free Beehiiv newsletter
// ===========================================================================

describe('GET /api/me free-tier first-login auto-subscribe', () => {
  // Stages a sql closure that returns "no row" for the local subscription
  // lookup and accepts the subsequent upsert.
  function stageNoLocalRow() {
    nextSqlResult = (sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return []
      }
      return []
    }
  }

  // Stages a sql closure that returns an existing row, so the gate trips
  // and Beehiiv is never called.
  function stageHasLocalRow(email: string) {
    nextSqlResult = (sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email,
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_existing',
            status: 'active',
            has_premium: false,
            updated_at: new Date().toISOString(),
          },
        ]
      }
      return []
    }
  }

  test('first login (no local row) → creates Beehiiv subscription, returns free shape', async () => {
    stageNoLocalRow()
    beehiivHandler = (call) => {
      // by_email lookup → 404 (no upstream record yet)
      if (call.url.includes('/subscriptions/by_email/')) {
        return new Response('{}', { status: 404 })
      }
      // POST /subscriptions → create
      if (call.url.endsWith('/subscriptions') && call.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_new',
              email: 'newfree@x.com',
              status: 'active',
              subscription_tier: 'free',
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 500 })
    }

    const token = await signAuth0Token({ email: 'newfree@x.com', tier: 'free' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'newfree@x.com',
      tier: 'free',
      feeds: [],
    })

    // Beehiiv was hit: lookup + create.
    expect(beehiivCalls.some((c) => c.url.includes('/by_email/'))).toBe(true)
    expect(
      beehiivCalls.some(
        (c) => c.url.endsWith('/subscriptions') && c.method === 'POST',
      ),
    ).toBe(true)

    // The mirror was upserted.
    expect(
      sqlCalls.some(
        (c) => c.sql.includes('insert into beehiiv_subscription'),
      ),
    ).toBe(true)
  })

  test('repeat login (local row exists) → no Beehiiv call, no upsert', async () => {
    stageHasLocalRow('returning@x.com')
    const token = await signAuth0Token({ email: 'returning@x.com', tier: 'free' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect(res.statusCode).toBe(200)
    expect((res.__json() as { tier: string }).tier).toBe('free')
    expect(beehiivCalls.length).toBe(0)
    expect(
      sqlCalls.some(
        (c) => c.sql.includes('insert into beehiiv_subscription'),
      ),
    ).toBe(false)
  })

  test('Beehiiv outage → /api/me still returns 200 free (soft-fail)', async () => {
    stageNoLocalRow()
    beehiivHandler = () =>
      new Response('{"error":"down"}', { status: 503 })

    const token = await signAuth0Token({ email: 'unlucky@x.com', tier: 'free' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'unlucky@x.com',
      tier: 'free',
      feeds: [],
    })
  })

  test('DATABASE_URL unset → auto-subscribe is skipped entirely, no Beehiiv call', async () => {
    // No DB to anchor idempotency → don't blindly write to Beehiiv every
    // request. Login still succeeds.
    const env = { ...BASE_ENV }
    delete env.DATABASE_URL
    const token = await signAuth0Token({ email: 'nodb@x.com', tier: 'free' })
    const handler = buildHandler(env)
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect(res.statusCode).toBe(200)
    expect((res.__json() as { tier: string }).tier).toBe('free')
    expect(beehiivCalls.length).toBe(0)
  })

  test('subscriber path does NOT trigger free auto-subscribe', async () => {
    scUserByEmail.set('paid@x.com', { id: 99, email: 'paid@x.com' })
    scFeedsByUserId.set(99, [])
    const token = await signAuth0Token({ email: 'paid@x.com', tier: 'ark-plus-member' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect((res.__json() as { tier: string }).tier).toBe('ark-plus-member')
    expect(beehiivCalls.length).toBe(0)
    expect(
      sqlCalls.some(
        (c) => c.sql.includes('beehiiv_subscription'),
      ),
    ).toBe(false)
  })
})
