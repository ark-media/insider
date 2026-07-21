// Unit tests for GET/PUT /api/me/newsletters.
//
// Strategy:
//   - `@neondatabase/serverless` is mocked so DB reads/writes are captured as
//     tagged-template calls without a live DB.
//   - Auth0 bearer tokens are real RS256 JWTs signed by a per-process test
//     keypair. The JWKS endpoint that `createRemoteJWKSet` consults is
//     intercepted by the global fetch mock, so jose-side verification
//     exercises the real path.
//   - The Auth0 management API (used by `fetchAuth0TierForEmail` for the
//     live-tier fallback) is also served by the global fetch mock.
//   - Beehiiv API calls go through the same fetch mock.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AUTH0_TEST_JWKS_URL,
  getAuth0TestKeys,
  signAuth0TestToken,
  silenceExpectedConsole,
} from './test-utils'

// ---------------------------------------------------------------------------
// Neon mock (same shape as beehiiv-webhook.test.ts)
// ---------------------------------------------------------------------------
type SqlCall = { sql: string; values: unknown[] }
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

// Premium eligibility now derives from a Neon membership row (the arkPlus axis),
// not the Auth0 tier claim. `markMember(email)` stages a live arkPlus row keyed
// on the token's sub (auth0|<email>); the mock returns it for the membership
// query and delegates every other query to `nextSqlResult`.
const arkPlusSubs = new Set<string>()
function markMember(email: string): void {
  arkPlusSubs.add(`auth0|${email}`)
}

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const merged = strings.join('?')
      sqlCalls.push({ sql: merged, values })
      if (merged.includes('from membership where auth0_sub')) {
        const sub = values[0] as string
        return Promise.resolve(
          arkPlusSubs.has(sub)
            ? [
                {
                  auth0_sub: sub,
                  stripe_customer_id: null,
                  stripe_subscription_id: null,
                  sc_user_id: null,
                  tier: 'ark-plus',
                  status: 'active',
                  plan: 'monthly',
                  amount_cents: 800,
                  current_period_end: null,
                  cancel_at: null,
                  gift_expires_at: null,
                },
              ]
            : [],
        )
      }
      return Promise.resolve(nextSqlResult(merged))
    }) as unknown,
  __esModule: true,
}))

// Static import AFTER mock.module so the plugin picks up the fake neon.
import { clearNewsletterRefreshCache } from './lib/beehiiv-sync.js'
import { devApiPlugin } from './dev-api'

const signAuth0Token = signAuth0TestToken

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

const PATH = '/api/me/newsletters'
const PUB_ID = 'pub_test-abc'
const AUTH0_TENANT = 'https://ark-media-test.us.auth0.com'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: PUB_ID,
  BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER: PUB_ID,
  BEEHIIV_PREMIUM_TIER_ID: 'pt_premium',
  // Distinct DATABASE_URL per test file: server/lib/db.ts's `getDb()` caches
  // the neon() client by url, and the cache is process-global. Different
  // URLs in different test files prevent one file's mocked sql closure
  // from being reused by another file (where the supporting state lives in
  // a different module scope).
  DATABASE_URL: 'postgres://stub-me-newsletters',
  // Required for fetchAuth0TierForEmail in the live-tier fallback.
  AUTH0_MANAGEMENT_CLIENT_ID: 'mgmt-cid',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'mgmt-csec',
  AUTH0_TENANT_DOMAIN: AUTH0_TENANT,
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
// Fake req/res (same as beehiiv-webhook.test.ts)
// ---------------------------------------------------------------------------
function makeReq(opts: {
  method?: string
  body?: unknown
  bearer?: string
}): IncomingMessage {
  const raw =
    opts.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(opts.body), 'utf8')
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'GET'
  stream.url = PATH
  stream.headers = { 'content-type': 'application/json' }
  if (opts.bearer) stream.headers['authorization'] = `Bearer ${opts.bearer}`
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

// ---------------------------------------------------------------------------
// fetch mock — serves JWKS, Auth0 mgmt token, Auth0 users-by-email, and
// Beehiiv subscription endpoints.
// ---------------------------------------------------------------------------
type FetchCall = { url: string; method: string; body: unknown }
const fetchCalls: FetchCall[] = []

// Per-test config:
let beehiivHandler: (call: FetchCall) => Response = () =>
  new Response('{}', { status: 404 })
let liveTierByEmail: Map<string, 'ark-plus-member' | 'free' | null> = new Map()

const originalFetch = globalThis.fetch
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : input.toString()
  let parsed: unknown = undefined
  if (init?.body && typeof init.body === 'string') {
    try {
      parsed = JSON.parse(init.body)
    } catch {
      parsed = init.body
    }
  }
  const call: FetchCall = { url, method: init?.method ?? 'GET', body: parsed }
  fetchCalls.push(call)

  // JWKS endpoint — served by jose's createRemoteJWKSet.
  if (url === AUTH0_TEST_JWKS_URL) {
    const { publicJwk } = await getAuth0TestKeys()
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  // Auth0 management — oauth/token + users-by-email.
  if (url.endsWith('/oauth/token')) {
    return new Response(
      JSON.stringify({ access_token: 'mgmt-tok', expires_in: 3600 }),
      { status: 200 },
    )
  }
  if (url.includes('/users-by-email')) {
    const email = decodeURIComponent(url.split('email=')[1]?.split('&')[0] ?? '')
    const tier = liveTierByEmail.get(email)
    if (tier === null || tier === undefined) {
      return new Response('[]', { status: 200 })
    }
    return new Response(
      JSON.stringify([{ app_metadata: { tier } }]),
      { status: 200 },
    )
  }
  // Beehiiv — defer to per-test handler.
  if (url.includes('api.beehiiv.com')) return beehiivHandler(call)
  return new Response('{}', { status: 500 })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  sqlCalls.length = 0
  fetchCalls.length = 0
  liveTierByEmail = new Map()
  arkPlusSubs.clear()
  nextSqlResult = () => []
  beehiivHandler = () => new Response('{}', { status: 404 })
  clearNewsletterRefreshCache()
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// ===========================================================================
// Auth + transport
// ===========================================================================

describe('newsletters auth', () => {
  test('401 when no bearer', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({}), res)
    expect(res.statusCode).toBe(401)
  })

  test('401 when bearer fails verification', async () => {
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: 'not-a-jwt' }), res)
    expect(res.statusCode).toBe(401)
  })

  test('405 on POST', async () => {
    const token = await signAuth0Token({ email: 'a@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({ method: 'POST', bearer: token }),
      res,
    )
    expect(res.statusCode).toBe(405)
  })
})

// ===========================================================================
// GET
// ===========================================================================

describe('GET /api/me/newsletters', () => {
  test('returns Beehiiv state after refresh (overrides stale local row)', async () => {
    markMember('a@x.com')
    const token = await signAuth0Token({ email: 'a@x.com' })
    beehiivHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_1',
              email: 'a@x.com',
              status: 'active',
              subscription_tier: 'premium',
              subscription_premium_tier_names: ['Premium'],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 404 })
    }
    nextSqlResult = (sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 'a@x.com',
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_1',
            status: 'active',
            has_premium: true,
            updated_at: new Date().toISOString(),
          },
        ]
      }
      return []
    }
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'a@x.com',
      free: true,
      premium: true,
      canPremium: true,
    })
  })

  test('returns all-false when Beehiiv has no subscription', async () => {
    const token = await signAuth0Token({ email: 'b@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'b@x.com',
      free: false,
      premium: false,
      canPremium: false,
    })
  })

  test('syncs active free subscription from Beehiiv when mirror is empty', async () => {
    const token = await signAuth0Token({ email: 'sync@x.com' })
    beehiivHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_sync',
              email: 'sync@x.com',
              status: 'active',
              subscription_tier: 'free',
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 404 })
    }
    nextSqlResult = (sql) => {
      if (sql.includes('insert into beehiiv_subscription')) {
        return []
      }
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 'sync@x.com',
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_sync',
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
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'sync@x.com',
      free: true,
      premium: false,
      canPremium: false,
    })
    expect(
      sqlCalls.some((c) => c.sql.includes('insert into beehiiv_subscription')),
    ).toBe(true)
  })

  test('pending Beehiiv status counts as subscribed (free: true)', async () => {
    const token = await signAuth0Token({ email: 'pending@x.com' })
    beehiivHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_pending',
              email: 'pending@x.com',
              status: 'pending',
              subscription_tier: 'free',
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 404 })
    }
    nextSqlResult = (sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 'pending@x.com',
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_pending',
            status: 'pending',
            has_premium: false,
            updated_at: new Date().toISOString(),
          },
        ]
      }
      return []
    }
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { free: boolean }).free).toBe(true)
  })

  test('canPremium flips on live tier lookup when JWT says free', async () => {
    const token = await signAuth0Token({ email: 'stale@x.com' })
    markMember('stale@x.com')
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect((res.__json() as { canPremium: boolean }).canPremium).toBe(true)
  })
})

// ===========================================================================
// PUT
// ===========================================================================

describe('PUT /api/me/newsletters', () => {
  test('400 when no fields supplied', async () => {
    const token = await signAuth0Token({ email: 'a@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({ method: 'PUT', bearer: token, body: {} }),
      res,
    )
    expect(res.statusCode).toBe(400)
  })

  test('403 when non-member tries to enable premium', async () => {
    const token = await signAuth0Token({ email: 'a@x.com' })
    liveTierByEmail.set('a@x.com', 'free')
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({ method: 'PUT', bearer: token, body: { premium: true } }),
      res,
    )
    expect(res.statusCode).toBe(403)
  })

  test('member can enable premium via combined PUT', async () => {
    markMember('m@x.com')
    const token = await signAuth0Token({ email: 'm@x.com' })
    beehiivHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_m',
              email: 'm@x.com',
              status: 'active',
              subscription_tier: 'free',
              subscription_premium_tier_names: [],
            },
          }),
          { status: 200 },
        )
      }
      if (method === 'PUT' && url.includes('/subscriptions/sub_m')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_m',
              email: 'm@x.com',
              status: 'active',
              subscription_tier: 'premium',
              subscription_premium_tier_names: ['Premium'],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 500 })
    }
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        method: 'PUT',
        bearer: token,
        body: { free: true, premium: true },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const put = fetchCalls.find(
      (c) =>
        c.method === 'PUT' && c.url.includes('api.beehiiv.com'),
    )
    expect(put?.body).toEqual({
      unsubscribe: false,
      premium_tier_ids: ['pt_premium'],
    })
  })

  test('503 premium_unavailable when no premium tier is configured', async () => {
    markMember('m@x.com')
    const token = await signAuth0Token({ email: 'm@x.com' })
    // No Beehiiv call should be attempted — the guard fires first.
    beehiivHandler = () => new Response('{}', { status: 500 })
    const { BEEHIIV_PREMIUM_TIER_ID: _omit, ...envNoTier } = BASE_ENV
    const handler = buildHandler(envNoTier)
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({ method: 'PUT', bearer: token, body: { premium: true } }),
      res,
    )
    expect(res.statusCode).toBe(503)
    expect(res.__json()).toEqual({ error: 'premium_unavailable' })
    // Confirm we never hit Beehiiv for this request.
    expect(
      fetchCalls.some((c) => c.url.includes('api.beehiiv.com')),
    ).toBe(false)
  })

  test('stale JWT but live-tier subscriber → premium toggle allowed', async () => {
    const token = await signAuth0Token({ email: 'upgraded@x.com' })
    markMember('upgraded@x.com')
    beehiivHandler = ({ method }) => {
      if (method === 'GET') return new Response('{}', { status: 404 })
      if (method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_u',
              email: 'upgraded@x.com',
              status: 'active',
              subscription_tier: 'premium',
              subscription_premium_tier_names: ['Premium'],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 500 })
    }
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(
      handler,
      makeReq({
        method: 'PUT',
        bearer: token,
        body: { premium: true },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
  })

  test('entitled member re-subscribing an inactive record reactivates via POST and re-applies premium implicitly', async () => {
    // Beehiiv's PUT `unsubscribe:false` does NOT reactivate an inactive
    // subscription — only the create endpoint with `reactivate_existing:true`
    // does. Toggling free back on for a subscriber must reactivate AND carry
    // the premium tier through the create call.
    markMember('re@x.com')
    const token = await signAuth0Token({ email: 're@x.com' })
    beehiivHandler = ({ method, url }) => {
      if (method === 'GET' && url.includes('/by_email/')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_r',
              email: 're@x.com',
              status: 'inactive',
              subscription_tier: 'free',
              subscription_premium_tier_names: [],
            },
          }),
          { status: 200 },
        )
      }
      if (method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_r',
              email: 're@x.com',
              status: 'active',
              subscription_tier: 'premium',
              subscription_premium_tier_names: ['Premium'],
            },
          }),
          { status: 201 },
        )
      }
      return new Response('{}', { status: 500 })
    }
    nextSqlResult = (sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 're@x.com',
            publication_id: 'pub_x',
            beehiiv_subscription_id: 'sub_r',
            status: 'active',
            has_premium: true,
            updated_at: '2020-01-01T00:00:00.000Z',
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
        method: 'PUT',
        bearer: token,
        body: { free: true }, // only free toggled
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect((res.__json() as Record<string, unknown>).free).toBe(true)
    const post = fetchCalls.find(
      (c) => c.method === 'POST' && c.url.includes('api.beehiiv.com'),
    )
    expect(post?.body).toMatchObject({
      email: 're@x.com',
      reactivate_existing: true,
      premium_tier_ids: ['pt_premium'],
    })
  })

  test('free user re-subscribing an inactive record reactivates via POST WITHOUT premium tier', async () => {
    // Mirrors the subscriber version above, but the implicit premium re-apply
    // must NOT happen — free users have no entitlement, and silently
    // upgrading them on a re-subscribe would be a privilege escalation.
    const token = await signAuth0Token({ email: 'freere@x.com' })
    liveTierByEmail.set('freere@x.com', 'free')
    beehiivHandler = ({ method, url }) => {
      if (method === 'GET' && url.includes('/by_email/')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_freere',
              email: 'freere@x.com',
              status: 'inactive',
              subscription_tier: 'free',
              subscription_premium_tier_names: [],
            },
          }),
          { status: 200 },
        )
      }
      if (method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_freere',
              email: 'freere@x.com',
              status: 'active',
              subscription_tier: 'free',
              subscription_premium_tier_names: [],
            },
          }),
          { status: 201 },
        )
      }
      return new Response('{}', { status: 500 })
    }
    nextSqlResult = (sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 'freere@x.com',
            publication_id: 'pub_x',
            beehiiv_subscription_id: 'sub_freere',
            status: 'active',
            has_premium: false,
            updated_at: '2020-01-01T00:00:00.000Z',
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
        method: 'PUT',
        bearer: token,
        body: { free: true },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect((res.__json() as Record<string, unknown>).free).toBe(true)
    const post = fetchCalls.find(
      (c) => c.method === 'POST' && c.url.includes('api.beehiiv.com'),
    )
    expect(post?.body).toMatchObject({ reactivate_existing: true })
    expect((post?.body as Record<string, unknown>).premium_tier_ids).toBeUndefined()
  })

  test('429 once the per-email rate bucket is empty', async () => {
    const token = await signAuth0Token({ email: 'spammy@x.com' })
    beehiivHandler = ({ method }) => {
      if (method === 'GET') return new Response('{}', { status: 404 })
      if (method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sub_x',
              email: 'spammy@x.com',
              status: 'active',
              subscription_tier: 'premium',
              subscription_premium_tier_names: ['Premium'],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 500 })
    }
    const handler = buildHandler()
    let last = 0
    for (let i = 0; i < 11; i += 1) {
      const res = makeRes()
      await runHandler(
        handler,
        makeReq({
          method: 'PUT',
          bearer: token,
          body: { free: true, premium: true },
        }),
        res,
      )
      last = res.statusCode
    }
    expect(last).toBe(429)
  })
})
