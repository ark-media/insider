// Unit tests for the member-initiated private-feed actions:
//
//   POST /api/me/feeds/email    → asks Beehiiv to email the member their feed
//   GET  /api/me/feeds/spotify  → mints Beehiiv's auto-login and 302s into
//                                 Beehiiv's Spotify Open Access consent flow
//
// The Spotify route hands out a live credential in a Location header, so the
// cases that matter most here are the gates around it: entitlement, origin, and
// never emitting the token in a body.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import {
  neonMockModule,
  type SqlCall,
  createDevApiHarness,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// Neon mock — membership row (entitlement) + beehiiv mirror row (subscription
// id for the JWT mint).
// ---------------------------------------------------------------------------
const sqlCalls: SqlCall[] = []
let membershipRows: unknown[] = []
let mirrorRows: unknown[] = []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged, values) => {
    if (merged.includes('from membership')) return membershipRows
    // Model the mirror upsert, so a refresh that re-resolves the subscription
    // against the configured publication actually replaces the stored row — the
    // behaviour the stale-publication test below depends on.
    if (merged.includes('insert into beehiiv_subscription')) {
      const [email, publication_id, beehiiv_subscription_id, status, has_premium] =
        values as [string, string, string, string, boolean]
      mirrorRows = [
        {
          email,
          publication_id,
          beehiiv_subscription_id,
          status,
          has_premium,
          updated_at: '2026-09-10T00:00:00Z',
        },
      ]
      return []
    }
    if (merged.includes('from beehiiv_subscription')) return mirrorRows
    return []
  }),
)

// Static imports AFTER mock.module so the plugin picks up the fake neon.
import { devApiPlugin } from './dev-api'
import { clearNewsletterRefreshCache } from './lib/beehiiv-sync'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'

const SHOW = 'pod_01a05d4d-d91e-7d23-b20e-7c225707635e'
const SUBSCRIBER_UUID = '0b6a3828-efa9-4df4-b959-f4b4c7081364'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  SESSION_SECRET: 'session-secret-for-tests-32-chars__',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test',
  BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK: SHOW,
  BEEHIIV_SUBSCRIBER_HOST: 'arkmedia.beehiiv.com',
  DATABASE_URL: 'postgres://stub-feed-actions-test',
}

const LIVE_ARK_PLUS = {
  auth0_sub: 'auth0|member',
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

const MIRROR_ROW = {
  email: 'member@x.com',
  publication_id: 'pub_test',
  beehiiv_subscription_id: 'sub_483208b6-0273-41a9-9c60-2468b6333110',
  status: 'active',
  has_premium: true,
  updated_at: '2026-09-10T00:00:00Z',
}

// A JWT whose payload carries the subscriber_id the URL path needs. Only the
// payload is read (the signature is Beehiiv's to verify), so a stub suffices.
function fakeJwt(subscriberId = SUBSCRIBER_UUID): string {
  const payload = Buffer.from(
    JSON.stringify({ subscriber_id: subscriberId, exp: 9999999999 }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

function buildHandler(path: string, env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(path)
}

function makeReq(opts: {
  path: string
  method?: string
  cookie?: string
  origin?: string
  body?: unknown
}): IncomingMessage {
  const payload =
    opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body))
  const stream = Readable.from([payload]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'GET'
  stream.url = opts.path
  stream.headers = { 'content-type': 'application/json' }
  if (opts.cookie) stream.headers['cookie'] = opts.cookie
  if (opts.origin) stream.headers['origin'] = opts.origin
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------
type FetchCall = { url: string; method: string }
let fetchCalls: FetchCall[] = []
let jwtStatus = 200
let feedEmailStatus = 200
// What Beehiiv answers for the by-email subscription lookup. null → 404.
let subscriptionByEmail: Record<string, unknown> | null = {
  id: 'sub_483208b6-0273-41a9-9c60-2468b6333110',
  email: 'member@x.com',
  status: 'active',
  subscription_tier: 'premium',
}

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  if (url.includes('/jwt_token')) {
    return jwtStatus === 200
      ? new Response(JSON.stringify({ data: { jwt_token: fakeJwt() } }), { status: 200 })
      : new Response('{"error":"JWT token fetching not allowed"}', { status: jwtStatus })
  }
  if (url.includes('/private_feeds/') && url.endsWith('/emails')) {
    return new Response('{}', { status: feedEmailStatus })
  }
  // Subscription lookup by email, against the CONFIGURED publication.
  if (url.includes('/subscriptions/by_email/')) {
    if (!subscriptionByEmail) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify({ data: subscriptionByEmail }), { status: 200 })
  }
  return new Response('{}', { status: 500 })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  sqlCalls.length = 0
  fetchCalls = []
  membershipRows = [LIVE_ARK_PLUS]
  mirrorRows = [MIRROR_ROW]
  jwtStatus = 200
  feedEmailStatus = 200
  subscriptionByEmail = {
    id: 'sub_483208b6-0273-41a9-9c60-2468b6333110',
    email: 'member@x.com',
    status: 'active',
    subscription_tier: 'premium',
  }
  clearNewsletterRefreshCache()
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

async function memberCookie(sub = 'auth0|member'): Promise<string> {
  const token = await signSessionToken(
    { email: 'member@x.com', roles: [], sub },
    BASE_ENV,
  )
  return `${SESSION_COOKIE_NAME}=${token}`
}

// ===========================================================================
// GET /api/me/feeds/spotify
// ===========================================================================
describe('GET /api/me/feeds/spotify', () => {
  const PATH = '/api/me/feeds/spotify'

  test('302s into the Spotify consent flow, carrying the minted JWT', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, cookie: await memberCookie(), origin: BASE_ENV.APP_BASE_URL }),
      res,
    )
    expect(res.statusCode).toBe(302)
    const location = new URL(res.getHeader('location') as string)
    expect(location.origin).toBe('https://arkmedia.beehiiv.com')
    expect(location.pathname).toBe('/oauth/spotify/authorize')
    // subscriber_id comes from the JWT payload, NOT the `sub_…` subscription
    // id — the wrong one renders a broken "no access" page.
    expect(location.searchParams.get('subscriber_id')).toBe(SUBSCRIBER_UUID)
    expect(location.searchParams.get('jwt_token')).toBe(fakeJwt())
    // The round trip has to end back on our own setup page.
    expect(location.searchParams.get('redirect_path')).toBe(
      `${BASE_ENV.APP_BASE_URL}/account/podcast-feed?spotify=linked`,
    )
    expect(location.href).not.toContain('sub_483208b6')
    // Never the subscriber profile, which offers "Cancel paid subscription".
    expect(location.href).not.toContain('/manage')
  })

  test('the credential is never returned in a body', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, cookie: await memberCookie(), origin: BASE_ENV.APP_BASE_URL }),
      res,
    )
    expect(res.__body()).toBe('')
    expect(res.getHeader('cache-control')).toBe('private, no-store')
  })

  test('401 without a session', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, origin: BASE_ENV.APP_BASE_URL }),
      res,
    )
    expect(res.statusCode).toBe(401)
    expect(fetchCalls.some((c) => c.url.includes('/jwt_token'))).toBe(false)
  })

  test('403 for a member without the Ark+ axis — no JWT is minted', async () => {
    membershipRows = [{ ...LIVE_ARK_PLUS, tier: 'circle' }]
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, cookie: await memberCookie(), origin: BASE_ENV.APP_BASE_URL }),
      res,
    )
    expect(res.statusCode).toBe(403)
    expect(fetchCalls.some((c) => c.url.includes('/jwt_token'))).toBe(false)
  })

  test('403 cross-origin — a credential must not be mintable from an off-site link', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, cookie: await memberCookie(), origin: 'https://evil.example' }),
      res,
    )
    expect(res.statusCode).toBe(403)
    expect(fetchCalls).toHaveLength(0)
  })

  test('resolves the subscription id against the CONFIGURED publication, not the mirror', async () => {
    // The regression this guards: a mirror row written before a publication
    // move still holds the OLD publication's subscription id. Minting against
    // the current publication with it fails with nothing in the response to say
    // why — the member just gets "Spotify unavailable".
    mirrorRows = [
      {
        ...MIRROR_ROW,
        publication_id: 'pub_OLD-publication',
        beehiiv_subscription_id: 'sub_STALE-from-the-old-publication',
      },
    ]
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, cookie: await memberCookie(), origin: BASE_ENV.APP_BASE_URL }),
      res,
    )
    expect(res.statusCode).toBe(302)
    // The JWT was minted for the id Beehiiv returned for this email, not the
    // stale one sitting in the mirror.
    const mint = fetchCalls.find((c) => c.url.includes('/jwt_token'))
    expect(mint?.url).toContain('sub_483208b6-0273-41a9-9c60-2468b6333110')
    expect(mint?.url).not.toContain('sub_STALE')
  })

  test('409 when the member has no Beehiiv subscription to mint against', async () => {
    mirrorRows = []
    subscriptionByEmail = null
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, cookie: await memberCookie(), origin: BASE_ENV.APP_BASE_URL }),
      res,
    )
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { error: string }).error).toBe('no_subscription')
  })

  test('503 when Beehiiv refuses to mint (auto-login disabled)', async () => {
    jwtStatus = 422
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({ path: PATH, cookie: await memberCookie(), origin: BASE_ENV.APP_BASE_URL }),
      res,
    )
    expect(res.statusCode).toBe(503)
    expect((res.__json() as { error: string }).error).toBe('spotify_unavailable')
  })

  test('503 when the subscriber host is unconfigured', async () => {
    // The authorize URL lives on the publication's own beehiiv domain, so
    // without it there is nowhere to send the member.
    const env = { ...BASE_ENV }
    delete env.BEEHIIV_SUBSCRIBER_HOST
    const res = makeRes()
    await runHandler(
      buildHandler(PATH, env),
      makeReq({
        path: PATH,
        cookie: `${SESSION_COOKIE_NAME}=${await signSessionToken({ email: 'member@x.com', roles: [], sub: 'auth0|member' }, env)}`,
        origin: env.APP_BASE_URL,
      }),
      res,
    )
    expect(res.statusCode).toBe(503)
  })
})

// ===========================================================================
// POST /api/me/feeds/email
// ===========================================================================
describe('POST /api/me/feeds/email', () => {
  const PATH = '/api/me/feeds/email'

  test('200 and asks Beehiiv to send to the session email', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: await memberCookie(),
        origin: BASE_ENV.APP_BASE_URL,
        body: {},
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const call = fetchCalls.find((c) => c.url.endsWith('/emails'))
    expect(call?.method).toBe('POST')
    // Addressed by the session's own email — a member cannot send it elsewhere.
    expect(call?.url).toContain(encodeURIComponent('member@x.com'))
    expect(call?.url).toContain(SHOW)
  })

  test('409 when Beehiiv has no feed token for the member yet', async () => {
    feedEmailStatus = 404
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: await memberCookie(),
        origin: BASE_ENV.APP_BASE_URL,
        body: {},
      }),
      res,
    )
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { error: string }).error).toBe('no_feed_yet')
  })

  test('403 for a member without the Ark+ axis', async () => {
    membershipRows = [{ ...LIVE_ARK_PLUS, tier: 'circle' }]
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: await memberCookie(),
        origin: BASE_ENV.APP_BASE_URL,
        body: {},
      }),
      res,
    )
    expect(res.statusCode).toBe(403)
    expect(fetchCalls).toHaveLength(0)
  })

  test('403 cross-origin', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(PATH),
      makeReq({
        path: PATH,
        method: 'POST',
        cookie: await memberCookie(),
        origin: 'https://evil.example',
        body: {},
      }),
      res,
    )
    expect(res.statusCode).toBe(403)
  })

  test('405 on GET', async () => {
    const res = makeRes()
    await runHandler(buildHandler(PATH), makeReq({ path: PATH, method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  test('rate-limits with 429 once the burst capacity is spent', async () => {
    // Unique email so this test's bucket doesn't collide with the others (the
    // limiter is module-scoped and persists across handler builds).
    const cookie = `${SESSION_COOKIE_NAME}=${await signSessionToken({ email: 'burst@x.com', roles: [], sub: 'auth0|member' }, BASE_ENV)}`
    const post = () =>
      makeReq({
        path: PATH,
        method: 'POST',
        cookie,
        origin: BASE_ENV.APP_BASE_URL,
        body: {},
      })
    for (let i = 0; i < 3; i++) {
      const ok = makeRes()
      await runHandler(buildHandler(PATH), post(), ok)
      expect(ok.statusCode).toBe(200)
    }
    const limited = makeRes()
    await runHandler(buildHandler(PATH), post(), limited)
    expect(limited.statusCode).toBe(429)
    expect(limited.getHeader('retry-after')).toBeDefined()
  })
})
