// Unit tests for POST /api/auth/checkout-session — the auto-login-after-
// payment endpoint that mints a short-lived HS256 JWT and provisions the
// member's SC/Auth0 records synchronously.
//
// Strategy mirrors gift.test.ts: `mock.module('stripe', …)` swaps the Stripe
// SDK for a recording fake; SC + Auth0 calls go through the global fetch mock.
//
// The endpoint resolves the subscription from a Checkout Session
// (stripe.checkout.sessions.retrieve with the subscription + customer
// expanded), so the fake wraps `nextSubscription` in a session object.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { jwtVerify } from 'jose'
import {
  createDevApiHarness,
  makeFakeReq,
  silenceExpectedConsole,
  type MakeReqOpts,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []

type FakeSubscription = {
  id: string
  status: 'incomplete' | 'active' | 'trialing' | 'incomplete_expired' | 'past_due'
  created: number
  customer: { id: string; email: string | null; name?: string; deleted?: false }
  metadata: Record<string, string>
}

let nextSubscription: FakeSubscription | null = null

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    retrieve: async (_id: string) => {
      stripeCalls.push({ method: 'customers.retrieve', args: [_id] })
      if (!nextSubscription) throw new Error('nextSubscription not configured')
      return nextSubscription.customer
    },
  }
  paymentIntents = {
    create: async () => ({}),
    retrieve: async () => ({}),
    update: async () => ({}),
  }
  webhooks = { constructEvent: () => ({}) }
  prices = { create: async () => ({}) }
  subscriptions = {
    create: async () => ({}),
    update: async (id: string, args: { metadata: Record<string, string> }) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      if (nextSubscription && nextSubscription.id === id) {
        nextSubscription.metadata = { ...nextSubscription.metadata, ...args.metadata }
      }
      return { id, metadata: args.metadata }
    },
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id] })
      if (!nextSubscription) throw new Error('nextSubscription not configured')
      return nextSubscription
    },
    list: async () => ({ data: [] }),
  }
  checkout = {
    sessions: {
      // Wraps `nextSubscription` (with its customer already an object) the way
      // the endpoint expects it expanded. A null sub models a session whose
      // payment hasn't completed yet.
      retrieve: async (id: string, _opts?: unknown) => {
        stripeCalls.push({ method: 'checkout.sessions.retrieve', args: [id] })
        return {
          id,
          status: nextSubscription ? 'complete' : 'open',
          subscription: nextSubscription,
        }
      },
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
const CHECKOUT_SECRET = 'test-checkout-secret-0123456789abcdef0123456789abcdef'

const PREMIUM_TIER_ID = 'tier_plus'

const BASE_ENV = {
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  BEEHIIV_API_KEY: 'bh_key',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test',
  BEEHIIV_PREMIUM_TIER_ID: PREMIUM_TIER_ID,
  CHECKOUT_SESSION_SECRET: CHECKOUT_SECRET,
}

// A Beehiiv subscriber the grant can land on, premium already applied.
const premiumSubscriberBody = JSON.stringify({
  data: {
    id: 'sub_bh_1',
    email: 'user@example.com',
    status: 'active',
    subscription_tier: 'premium',
    subscription_premium_tier_names: ['Plus'],
  },
})

function getHandler(path: string, envOverrides?: Record<string, string>): Middleware {
  return createDevApiHarness(
    devApiPlugin({ ...BASE_ENV, ...envOverrides }),
  ).getHandler(path)
}

// ---------------------------------------------------------------------------
// Fake req/res
// ---------------------------------------------------------------------------
type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __header: (name: string) => string | string[] | undefined
}

const makeReq = (o: MakeReqOpts = {}) =>
  makeFakeReq({ method: 'POST', url: PATH, ...o })

function makeRes(): FakeRes {
  const headers: Record<string, string | string[]> = {}
  let body = ''
  let statusCode = 200
  let ended = false
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
    setHeader(name: string, value: string | number | string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value : String(value)
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
    __header: (name: string) => headers[name.toLowerCase()],
  } as unknown as FakeRes
  return res
}

function parseSetCookies(setCookie: string | string[] | undefined): Map<string, { value: string; attrs: Record<string, string> }> {
  const out = new Map<string, { value: string; attrs: Record<string, string> }>()
  if (!setCookie) return out
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of list) {
    const [nv, ...rest] = c.split(';')
    const eq = nv.indexOf('=')
    if (eq < 0) continue
    const name = nv.slice(0, eq).trim()
    const value = nv.slice(eq + 1).trim()
    const attrs: Record<string, string> = {}
    for (const a of rest) {
      const aeq = a.indexOf('=')
      if (aeq < 0) attrs[a.trim().toLowerCase()] = ''
      else attrs[a.slice(0, aeq).trim().toLowerCase()] = a.slice(aeq + 1).trim()
    }
    out.set(name, { value, attrs })
  }
  return out
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
// SC fetch mock (Auth0 mgmt calls also go through here — we'll happy-path
// them with empty 200 responses since the endpoint doesn't fail on Auth0
// problems; it just logs and moves on).
// ---------------------------------------------------------------------------
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []
let fetchImpl: FetchImpl = async () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  let parsed: unknown = undefined
  if (init?.body && typeof init.body === 'string') {
    try {
      parsed = JSON.parse(init.body)
    } catch {
      parsed = init.body
    }
  }
  fetchCalls.push({ url, method: init?.method ?? 'GET', body: parsed })
  return fetchImpl(url, init)
}) as typeof fetch

// Several tests drive soft-fail paths (e.g. the welcome email skipping when
// RESEND_API_KEY is unset) that log via console.error/warn — expected noise.
silenceExpectedConsole()

afterAll(() => {
  globalThis.fetch = originalFetch
})

const PATH = '/api/auth/checkout-session'
const ME_PATH = '/api/me'

beforeEach(() => {
  fetchCalls.length = 0
  stripeCalls.length = 0
  nextSubscription = null
  // Default: no Beehiiv subscriber yet, so the premium grant creates one;
  // Auth0 mgmt calls happy-path. Specific tests override as needed.
  fetchImpl = async (url, init) => {
    if (url.includes('/subscriptions/by_email/')) {
      return new Response('{"error":"not found"}', { status: 404 })
    }
    if (
      url.includes('api.beehiiv.com') &&
      url.endsWith('/subscriptions') &&
      init?.method === 'POST'
    ) {
      return new Response(premiumSubscriberBody, { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
})

function activeSub(overrides: Partial<FakeSubscription> = {}): FakeSubscription {
  return {
    id: 'sub_test_1',
    status: 'active',
    created: Math.floor(Date.now() / 1000) - 10, // 10s ago
    customer: { id: 'cus_1', email: 'user@example.com', name: 'Test User' },
    metadata: { plan: 'monthly' },
    ...overrides,
  }
}

// ===========================================================================
// Validation
// ===========================================================================

describe('POST /api/auth/checkout-session — validation', () => {
  test('405 on GET', async () => {
    const h = getHandler(PATH)
    const req = makeReq({ method: 'GET' })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(405)
  })

  test('500 when STRIPE_SECRET_KEY is missing', async () => {
    const h = getHandler(PATH, { STRIPE_SECRET_KEY: '' })
    const req = makeReq({ body: { checkout_session_id: 'cs_1', email: 'x@y.com' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(500)
    expect((res.__json() as { error: string }).error).toBe('not_configured')
  })

  test('500 when CHECKOUT_SESSION_SECRET is missing', async () => {
    const h = getHandler(PATH, { CHECKOUT_SESSION_SECRET: '' })
    const req = makeReq({ body: { checkout_session_id: 'cs_1', email: 'x@y.com' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(500)
    expect((res.__json() as { error: string }).error).toBe('not_configured')
  })

  test('400 when checkout_session_id is missing', async () => {
    const h = getHandler(PATH)
    const req = makeReq({ body: { email: 'x@y.com' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/checkout_session_id/i)
    expect(stripeCalls).toHaveLength(0)
  })

  test('400 when email is missing', async () => {
    const h = getHandler(PATH)
    const req = makeReq({ body: { checkout_session_id: 'cs_1' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/email/i)
    expect(stripeCalls).toHaveLength(0)
  })

  test('403 when email does not match Stripe customer', async () => {
    nextSubscription = activeSub({
      customer: { id: 'cus_1', email: 'real-owner@example.com' },
    })
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_1', email: 'attacker@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(403)
  })

  test('410 when subscription is older than the auto-login window (1h)', async () => {
    nextSubscription = activeSub({
      created: Math.floor(Date.now() / 1000) - 2 * 60 * 60, // 2h ago
    })
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(410)
    expect((res.__json() as { error: string }).error).toMatch(/expired/i)
  })

  test('202 with status=incomplete while Stripe is still transitioning', async () => {
    nextSubscription = activeSub({ status: 'incomplete' })
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(202)
    const body = res.__json() as { ready: boolean; status: string }
    expect(body.ready).toBe(false)
    expect(body.status).toBe('incomplete')
    // No provisioning attempted while still incomplete.
    expect(
      fetchCalls.some((c) => c.url.endsWith('/users/search')),
    ).toBe(false)
  })
})

// ===========================================================================
// Happy path: token issuance + roundtrip
// ===========================================================================

describe('POST /api/auth/checkout-session — happy path', () => {
  test('200 sets httpOnly session cookie with a valid HS256 token', async () => {
    nextSubscription = activeSub()
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)

    expect(res.statusCode).toBe(200)
    const body = res.__json() as {
      ready: boolean
      email: string
      expires_in: number
    }
    expect(body.ready).toBe(true)
    expect(body.email).toBe('user@example.com')
    expect(body.expires_in).toBe(30 * 60)
    // The token must NOT appear in the response body.
    expect(JSON.stringify(body)).not.toContain('access_token')

    const cookies = parseSetCookies(res.__header('set-cookie'))
    const session = cookies.get('ark_checkout')
    expect(session).toBeDefined()
    expect(session!.attrs['httponly']).toBe('')
    expect(session!.attrs['path']).toBe('/')
    expect(session!.attrs['samesite']?.toLowerCase()).toBe('lax')
    expect(Number(session!.attrs['max-age'])).toBe(30 * 60)

    const hint = cookies.get('ark_checkout_present')
    expect(hint).toBeDefined()
    expect(hint!.value).toBe('1')
    // The hint cookie is JS-readable, so it must NOT have HttpOnly.
    expect(hint!.attrs['httponly']).toBeUndefined()

    const { payload } = await jwtVerify(
      session!.value,
      new TextEncoder().encode(CHECKOUT_SECRET),
      { issuer: 'ark-insider', audience: 'checkout-session' },
    )
    expect(payload.email).toBe('user@example.com')
    expect(typeof payload.iat).toBe('number')
    expect(typeof payload.exp).toBe('number')
    expect((payload.exp as number) - (payload.iat as number)).toBe(30 * 60)
  })

  test('email param is normalized to lowercase', async () => {
    nextSubscription = activeSub()
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: '  User@Example.COM  ' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { email: string }).email).toBe('user@example.com')
  })

  test('grants the Beehiiv premium tier when the sub is not yet marked', async () => {
    nextSubscription = activeSub()
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)

    // Looked the member up, then created them on the premium tier.
    expect(fetchCalls.some((c) => c.url.includes('/subscriptions/by_email/'))).toBe(true)
    const grant = fetchCalls.find(
      (c) =>
        c.method === 'POST' &&
        c.url.includes('api.beehiiv.com') &&
        c.url.endsWith('/subscriptions'),
    )
    expect(grant).toBeDefined()
    expect((grant!.body as { premium_tier_ids: string[] }).premium_tier_ids).toEqual([
      PREMIUM_TIER_ID,
    ])

    // Stripe metadata was stamped so a redelivery doesn't re-grant.
    const update = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect(update).toBeDefined()
    const md = (update!.args[1] as { metadata: Record<string, string> }).metadata
    expect(md.beehiiv_premium).toBe('true')
  })

  test('sends the branded subscriber welcome email after provisioning', async () => {
    nextSubscription = activeSub()
    fetchImpl = async (url, init) => {
      if (url.includes('/subscriptions/by_email/')) {
        return new Response('{"error":"not found"}', { status: 404 })
      }
      if (
        url.includes('api.beehiiv.com') &&
        url.endsWith('/subscriptions') &&
        init?.method === 'POST'
      ) {
        return new Response(premiumSubscriberBody, { status: 200 })
      }
      if (url.startsWith('https://api.resend.com')) {
        return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    const h = getHandler(PATH, { RESEND_API_KEY: 'rk_test' })
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)

    const emailCall = fetchCalls.find(
      (c) => c.method === 'POST' && c.url.startsWith('https://api.resend.com'),
    )
    expect(emailCall).toBeDefined()
    const body = emailCall!.body as { to: string; subject: string; html: string }
    expect(body.to).toBe('user@example.com')
    expect(body.subject).toBe('Welcome to Ark+')
    expect(body.html).toContain('Welcome to Ark+.')
  })

  test('idempotent: skips the grant if the sub is already marked', async () => {
    nextSubscription = activeSub({
      metadata: { plan: 'monthly', beehiiv_premium: 'true' },
    })
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)

    // Nothing reached Beehiiv — not even the lookup.
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(false)
    // No Stripe metadata update either (already stamped)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
  })

  test('502 and no session cookie when the premium grant fails', async () => {
    // The grant is the feed. If it didn't land, the buyer must not be handed a
    // session that tells the app they have access — the webhook retries.
    nextSubscription = activeSub()
    fetchImpl = async (url) => {
      if (url.includes('/subscriptions/by_email/')) {
        return new Response('{"error":"not found"}', { status: 404 })
      }
      if (url.includes('api.beehiiv.com') && url.endsWith('/subscriptions')) {
        return new Response('{"error":"beehiiv down"}', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(502)
    expect(res.__header('set-cookie')).toBeUndefined()
  })

  test('trialing status is accepted (not just active)', async () => {
    nextSubscription = activeSub({ status: 'trialing' })
    const h = getHandler(PATH)
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// Rate limiting
// ===========================================================================

describe('POST /api/auth/checkout-session — rate limit', () => {
  test('429 after 25 requests with retry-after header', async () => {
    nextSubscription = activeSub()
    const h = getHandler(PATH)

    // Burn through the 25-token bucket. The first 25 should succeed.
    for (let i = 0; i < 25; i++) {
      const req = makeReq({
        body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
      })
      const res = makeRes()
      await runHandler(h, req, res)
      expect(res.statusCode).toBe(200)
    }

    // The 26th gets rate-limited.
    const req = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(429)
    const retry = res.__header('retry-after')
    expect(retry).toBeDefined()
    expect(Number(retry)).toBeGreaterThan(0)
  })

  test('rate limit is per-session — a different session is not blocked', async () => {
    nextSubscription = activeSub({ id: 'sub_A' })
    const h = getHandler(PATH)

    // Exhaust sub_A's bucket.
    for (let i = 0; i < 25; i++) {
      nextSubscription = activeSub({ id: 'sub_A' })
      const req = makeReq({
        body: { checkout_session_id: 'cs_A', email: 'user@example.com' },
      })
      const res = makeRes()
      await runHandler(h, req, res)
      expect(res.statusCode).toBe(200)
    }

    // sub_B is still allowed.
    nextSubscription = activeSub({ id: 'sub_B' })
    const req = makeReq({
      body: { checkout_session_id: 'cs_B', email: 'user@example.com' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// Token acceptance by other endpoints (verifies getSessionEmail dual-token)
// ===========================================================================

describe('Checkout cookie works with other authenticated endpoints', () => {
  test('GET /api/me accepts the httpOnly cookie set by /api/auth/checkout-session', async () => {
    // 1) Mint a session via the endpoint and extract the cookie.
    nextSubscription = activeSub()
    const checkout = getHandler(PATH)
    const mintReq = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const mintRes = makeRes()
    await runHandler(checkout, mintReq, mintRes)
    expect(mintRes.statusCode).toBe(200)
    const cookies = parseSetCookies(mintRes.__header('set-cookie'))
    const sessionToken = cookies.get('ark_checkout')?.value
    expect(sessionToken).toBeDefined()

    // 2) Call /api/me with that token in a Cookie header.
    //
    // No membership row is staged here, so the answer is the deliberate
    // provisioning-gap 401 (`membership_not_found`) rather than a member body —
    // and that is exactly what proves the cookie was ACCEPTED: an unreadable
    // token answers `unauthenticated` instead, which is what the forged-cookie
    // test below asserts. Entitlement itself is covered in me.test.ts.
    const meHandler = getHandler(ME_PATH)
    const meReq = makeReq({
      method: 'GET',
      url: ME_PATH,
      headers: { cookie: `ark_checkout=${sessionToken}` },
    })
    const meRes = makeRes()
    await runHandler(meHandler, meReq, meRes)
    expect((meRes.__json() as { error: string }).error).toBe('membership_not_found')
  })

  test('GET /api/me rejects a cookie signed with the wrong secret', async () => {
    const { SignJWT } = await import('jose')
    const forged = await new SignJWT({ email: 'user@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('ark-insider')
      .setAudience('checkout-session')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('wrong-secret'))

    const meHandler = getHandler(ME_PATH)
    const meReq = makeReq({
      method: 'GET',
      url: ME_PATH,
      headers: { cookie: `ark_checkout=${forged}` },
    })
    const meRes = makeRes()
    await runHandler(meHandler, meReq, meRes)
    expect(meRes.statusCode).toBe(401)
    // Unreadable token → the identity never resolves at all.
    expect((meRes.__json() as { error: string }).error).toBe('unauthenticated')
  })

  test('GET /api/me rejects a cookie with the wrong audience', async () => {
    const { SignJWT } = await import('jose')
    const wrongAud = await new SignJWT({ email: 'user@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('ark-insider')
      .setAudience('some-other-audience')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(CHECKOUT_SECRET))

    const meHandler = getHandler(ME_PATH)
    const meReq = makeReq({
      method: 'GET',
      url: ME_PATH,
      headers: { cookie: `ark_checkout=${wrongAud}` },
    })
    const meRes = makeRes()
    await runHandler(meHandler, meReq, meRes)
    expect(meRes.statusCode).toBe(401)
  })

  test('GET /api/me rejects an expired cookie', async () => {
    const { SignJWT } = await import('jose')
    const expired = await new SignJWT({ email: 'user@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer('ark-insider')
      .setAudience('checkout-session')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(CHECKOUT_SECRET))

    const meHandler = getHandler(ME_PATH)
    const meReq = makeReq({
      method: 'GET',
      url: ME_PATH,
      headers: { cookie: `ark_checkout=${expired}` },
    })
    const meRes = makeRes()
    await runHandler(meHandler, meReq, meRes)
    expect(meRes.statusCode).toBe(401)
  })

  test('GET /api/me returns 401 when no Bearer and no cookie are present', async () => {
    const meHandler = getHandler(ME_PATH)
    const meReq = makeReq({ method: 'GET', url: ME_PATH })
    const meRes = makeRes()
    await runHandler(meHandler, meReq, meRes)
    expect(meRes.statusCode).toBe(401)
  })
})

// ===========================================================================
// POST /api/signout
// ===========================================================================

describe('POST /api/signout — clears checkout cookies', () => {
  test('returns 200 and emits Max-Age=0 Set-Cookie for both cookies', async () => {
    const h = getHandler('/api/signout')
    const req = makeReq({ method: 'POST', url: '/api/signout' })
    const res = makeRes()
    await runHandler(h, req, res)

    expect(res.statusCode).toBe(200)
    const cookies = parseSetCookies(res.__header('set-cookie'))
    expect(cookies.get('ark_checkout')?.attrs['max-age']).toBe('0')
    expect(cookies.get('ark_checkout')?.attrs['httponly']).toBe('')
    expect(cookies.get('ark_checkout_present')?.attrs['max-age']).toBe('0')
  })

  test('405 on GET', async () => {
    const h = getHandler('/api/signout')
    const req = makeReq({ method: 'GET', url: '/api/signout' })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(405)
  })
})

// ===========================================================================
// Provisioning race (concurrent webhook + endpoint)
// ===========================================================================

describe('Provisioning race — concurrent callers do not double-create', () => {
  test('two concurrent calls produce exactly one Beehiiv grant', async () => {
    nextSubscription = activeSub()

    // Slow down the Beehiiv create so both callers enter the critical section
    // concurrently. Without dedup, both would grant. (A double grant is benign
    // upstream — Beehiiv is idempotent on the email — but the second call also
    // re-sends the welcome email, which is not.)
    let grants = 0
    fetchImpl = async (url, init) => {
      if (url.includes('/subscriptions/by_email/')) {
        return new Response('{"error":"not found"}', { status: 404 })
      }
      if (
        url.includes('api.beehiiv.com') &&
        url.endsWith('/subscriptions') &&
        init?.method === 'POST'
      ) {
        grants++
        await new Promise((r) => setTimeout(r, 50))
        return new Response(premiumSubscriberBody, { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }

    const h = getHandler(PATH)
    const reqA = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const resA = makeRes()
    const reqB = makeReq({
      body: { checkout_session_id: 'cs_test_1', email: 'user@example.com' },
    })
    const resB = makeRes()

    // Fire them in parallel.
    await Promise.all([runHandler(h, reqA, resA), runHandler(h, reqB, resB)])

    expect(resA.statusCode).toBe(200)
    expect(resB.statusCode).toBe(200)
    // The provisioning lock should have dedup'd these — only one grant.
    expect(grants).toBe(1)
  })
})
