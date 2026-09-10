// Unit tests for GET /api/me.
//
// Entitlement comes from a Neon membership row; the private feed comes from
// Beehiiv, keyed on the session email. Two healthy outcomes:
//   - live arkPlus row → 200 { tier: 'ark-plus', feeds: [the private feed] }
//   - no row on a durable Auth0 session → 200 { tier: 'free', feeds: [] }
// The legacy 401 stays only for the checkout-cookie path (issued post-payment,
// so no entitlement there is a provisioning gap, not a free user).

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import {
  neonMockModule,
  type SqlCall,
  AUTH0_TEST_JWKS_URL,
  createDevApiHarness,
  jwksResponse,
  makeFakeReq as makeReq,
  makeFakeRes as makeRes,
  parseJsonInitBody,
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
// A live membership row is what grants an axis now, so most tests stage one
// here rather than staging an upstream record.
let membershipRows: unknown[] = []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) =>
    merged.includes('from membership') ? membershipRows : nextSqlResult(merged),
  ),
)

// A live Ark+ subscription row for `sub`. signAuth0TestToken subjects every
// bearer as `auth0|<email>`, and the resolver keys on that sub.
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

// --- Stripe mock ------------------------------------------------------------
// A session with no Auth0 `sub` (the checkout cookie, minted before Auth0
// provisioning stamps one) reaches its membership row by email → Stripe
// customer → row. Stage the customer here; the row itself comes from the Neon
// mock above, which is keyed by nothing, so any customer resolves it.
let stripeCustomers: Array<{ id: string }> = []
class FakeStripe {
  customers = {
    list: async (_args: { email: string; limit: number }) => ({ data: stripeCustomers }),
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}
mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER mock.module so the plugin picks up the fakes.
import { devApiPlugin } from './dev-api'
import { clearPrivateFeedCache } from './lib/beehiiv-feeds'
import { signCheckoutToken, signSessionToken } from './lib/session'
import { CHECKOUT_COOKIE_NAME, SESSION_COOKIE_NAME } from './lib/cookies'

const signAuth0Token = signAuth0TestToken

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const PATH = '/api/me'
const PUB_ID = 'pub_test-me'
const SHOW_ID = 'pod_test-show'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'http://localhost:5173',
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-sc-key',
  CHECKOUT_SESSION_SECRET: 'checkout-secret-for-tests-0123456789',
  SESSION_SECRET: 'session-secret-for-tests-32-chars__',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: PUB_ID,
  BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER: PUB_ID,
  BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK: SHOW_ID,
  STRIPE_SECRET_KEY: 'sk_test_me',
  // getDb() caches the neon() client by URL across the process; distinct URL
  // per test file keeps each file's mocked sql closure isolated.
  DATABASE_URL: 'postgres://stub-me-test',
}

// Rebuilds handlers per call so the one test that passes a custom env gets a
// fresh registration; most calls use BASE_ENV.
function buildHandler(env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(PATH)
}

// ---------------------------------------------------------------------------
// fetch mock — serves JWKS, Simplecast, and Beehiiv.
// ---------------------------------------------------------------------------
type BeehiivCall = { url: string; method: string; body: unknown }

// The member's private feed, keyed by email. Absent → Beehiiv 404s, which is
// how "this member has no feed" is expressed upstream.
let privateFeedByEmail: Map<string, { token: string; activated?: number }> = new Map()
let privateFeedStatus = 0 // non-zero forces this status on the feed lookup
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
  if (url === AUTH0_TEST_JWKS_URL) return jwksResponse()

  // Beehiiv private feed by email.
  const feedMatch = url.match(/\/private_feeds\/by_email\/([^/?]+)$/)
  if (feedMatch) {
    if (privateFeedStatus !== 0) {
      return new Response('{"errors":[{"message":"nope"}]}', { status: privateFeedStatus })
    }
    const email = decodeURIComponent(feedMatch[1])
    const feed = privateFeedByEmail.get(email)
    if (!feed) {
      return new Response(
        '{"errors":[{"message":"Couldn\'t find podcasts::feedtoken"}]}',
        { status: 404 },
      )
    }
    return new Response(
      JSON.stringify({
        data: {
          id: 'pod_feed_abc',
          url: `https://rss.beehiiv.com/podcasts/x/private/${feed.token}.xml`,
          protocol_links: {
            apple: `podcast://rss.beehiiv.com/${feed.token}`,
            pocket_casts: `pktc://subscribe/${feed.token}`,
          },
          created: 1788982716,
          activated: feed.activated ?? null,
          revoked: null,
          expires: null,
          show: {
            id: SHOW_ID,
            title: 'Giraffe Sandbox | Ark+',
            artwork_url: 'https://media.beehiiv.com/art.png',
          },
        },
      }),
      { status: 200 },
    )
  }

  // Beehiiv — defer to per-test handler so tests can stage create/lookup
  // outcomes and assert which endpoints were hit.
  if (url.includes('api.beehiiv.com')) {
    const call: BeehiivCall = {
      url,
      method: init?.method ?? 'GET',
      body: parseJsonInitBody(init),
    }
    beehiivCalls.push(call)
    return beehiivHandler(call)
  }

  return new Response('{}', { status: 500 })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  privateFeedByEmail = new Map()
  privateFeedStatus = 0
  membershipRows = []
  stripeCustomers = []
  clearPrivateFeedCache()
  sqlCalls.length = 0
  nextSqlResult = () => []
  beehiivCalls = []
  beehiivHandler = () => new Response('{}', { status: 404 })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// Per-axis access shapes in the /api/me response (T7.1): the free path (both
// axes inactive) and a live Ark+ subscription (attributed to a subscription,
// no gift expiry).
const FREE_AXIS = { active: false, source: null, expiresAt: null, renewsAt: null }
const SUB_ARKPLUS_AXIS = {
  active: true,
  source: 'subscription',
  expiresAt: null,
  renewsAt: null,
}
const FREE_AXES = { arkPlus: FREE_AXIS, circle: FREE_AXIS }
const ARKPLUS_AXES = { arkPlus: SUB_ARKPLUS_AXIS, circle: FREE_AXIS }

// None of the tokens minted below carry the Login Action's name claims, so
// every response resolves to "no name held". Spread into the shape assertions
// rather than repeating the pair twelve times.
const NO_NAME = { firstName: null }

// `passwordResettable` says whether the account holds a password at all, from
// the primary Auth0 sub's connection prefix. signAuth0TestToken subjects every
// bearer as `auth0|<email>` (the database connection), so bearer-authenticated
// responses report true; a checkout token carries no sub and reports false.
const DB_IDENTITY = { passwordResettable: true }
const NO_PASSWORD = { passwordResettable: false }

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
    const token = await signAuth0Token({ email: 'free@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'free@x.com',
      tier: 'free',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: false, circle: false },
      axes: FREE_AXES,
      feeds: [],
    })
  })

  test('live arkPlus row → 200 subscriber shape carrying the private feed', async () => {
    membershipRows = [arkPlusRow('auth0|paid@x.com')]
    privateFeedByEmail.set('paid@x.com', { token: 'tok' })
    const token = await signAuth0Token({ email: 'paid@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'paid@x.com',
      tier: 'ark-plus',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: true, circle: false },
      axes: ARKPLUS_AXES,
      feeds: [
        {
          id: SHOW_ID,
          name: 'Giraffe Sandbox | Ark+',
          url: 'https://rss.beehiiv.com/podcasts/x/private/tok.xml',
          image_url: 'https://media.beehiiv.com/art.png',
          protocolLinks: {
            apple: 'podcast://rss.beehiiv.com/tok',
            pocket_casts: 'pktc://subscribe/tok',
          },
        },
      ],
    })
  })

  test('a stale tier claim does not matter — the Neon row decides', async () => {
    // A recently-upgraded member's access token still carries the pre-upgrade
    // 'free' claim. Entitlement is read live from Neon, so they don't lose
    // access until their next token refresh.
    membershipRows = [arkPlusRow('auth0|upgraded@x.com')]
    const token = await signAuth0Token({ email: 'upgraded@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'upgraded@x.com',
      tier: 'ark-plus',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: true, circle: false },
      axes: ARKPLUS_AXES,
      feeds: [],
    })
  })

  test('the feed carries activation state straight from Beehiiv', async () => {
    // Belt and braces: the GET reports `activated`, so a missed webhook can't
    // strand the setup page on "not set up yet".
    membershipRows = [arkPlusRow('auth0|active@x.com')]
    privateFeedByEmail.set('active@x.com', { token: 'tok', activated: 1789000000 })
    const token = await signAuth0Token({ email: 'active@x.com' })
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ bearer: token }), res)
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    expect(feeds[0]).toMatchObject({ activated: true })
    expect(feeds[0].activated_at).toBe(new Date(1789000000 * 1000).toISOString())
  })

  test('the rotating feed token is never the id the client round-trips', async () => {
    // `pod_feed_<uuid>` changes on reissue; the setup marker and `?feed=` are
    // keyed on the show id so a rotation can't orphan them.
    membershipRows = [arkPlusRow('auth0|paid@x.com')]
    privateFeedByEmail.set('paid@x.com', { token: 'tok' })
    const token = await signAuth0Token({ email: 'paid@x.com' })
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ bearer: token }), res)
    const feeds = (res.__json() as { feeds: Array<Record<string, unknown>> }).feeds
    expect(feeds[0].id).toBe(SHOW_ID)
    expect(JSON.stringify(feeds[0])).not.toContain('pod_feed_abc')
  })

  test('Auth0 bearer with no membership row → 200 free', async () => {
    // Neon is authoritative: no row on a durable login is a logged-in free
    // user. The legacy 401 now applies only to the checkout cookie
    // (post-payment), not to an Auth0 session.
    const token = await signAuth0Token({ email: 'gone@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'gone@x.com',
      tier: 'free',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: false, circle: false },
      axes: FREE_AXES,
      feeds: [],
    })
  })

  test('no tier claim and no row → 200 free (safety net for a missing Action)', async () => {
    const token = await signAuth0Token({ email: 'unknown-tier@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'unknown-tier@x.com',
      tier: 'free',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: false, circle: false },
      axes: FREE_AXES,
      feeds: [],
    })
  })

  test('a 404 from the feed lookup is tolerated: entitled, feeds empty', async () => {
    // The member is entitled but Beehiiv hasn't minted their feed yet. Both
    // 404 variants (no subscriber / not premium) look the same and must not
    // affect the membership decision.
    membershipRows = [arkPlusRow('auth0|newpaid@x.com')]
    const token = await signAuth0Token({ email: 'newpaid@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'newpaid@x.com',
      tier: 'ark-plus',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: true, circle: false },
      axes: ARKPLUS_AXES,
      feeds: [],
    })
  })

  test('a Beehiiv outage never costs a member their membership', async () => {
    // Entitlement came from Neon; the feed lookup is decoration. A 500 upstream
    // must degrade to "no feed yet", not to "not a member" and not to a 500.
    membershipRows = [arkPlusRow('auth0|oops@x.com')]
    privateFeedStatus = 500
    const token = await signAuth0Token({ email: 'oops@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'oops@x.com',
      tier: 'ark-plus',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: true, circle: false },
      axes: ARKPLUS_AXES,
      feeds: [],
    })
  })

  test('a 422 (show not premium) is a config alarm, not a member state', async () => {
    membershipRows = [arkPlusRow('auth0|conf@x.com')]
    privateFeedStatus = 422
    const token = await signAuth0Token({ email: 'conf@x.com' })
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { tier: string }).tier).toBe('ark-plus')
    expect((res.__json() as { feeds: unknown[] }).feeds).toEqual([])
  })
})

// ===========================================================================
// Checkout-cookie session → never falls back to free
// ===========================================================================

// Neither cookie fixture below stamps an Auth0 `sub` on the session, so these
// resolve to "we don't know which connection this is" — which reports false.
// That is the safe direction: a missing sub never offers a password reset for
// an account that may not have one.
describe('GET /api/me with checkout-cookie session', () => {
  test('checkout cookie + a row reachable by Stripe customer → 200 subscriber', async () => {
    // A checkout token carries no sub, so the row is reached by the by-email
    // net (email → Stripe customer → membership).
    membershipRows = [arkPlusRow('auth0|fresh')]
    stripeCustomers = [{ id: 'cus_1' }]
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
      tier: 'ark-plus',
      ...NO_NAME,
      ...NO_PASSWORD,
      entitlements: { arkPlus: true, circle: false },
      axes: ARKPLUS_AXES,
      feeds: [],
    })
  })

  test('session cookie + a row reachable by Stripe customer → 200 subscriber', async () => {
    membershipRows = [arkPlusRow('auth0|member')]
    stripeCustomers = [{ id: 'cus_1' }]
    const token = await signSessionToken({ email: 'member@x.com', roles: [] }, BASE_ENV)
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'member@x.com',
      tier: 'ark-plus',
      ...NO_NAME,
      ...NO_PASSWORD,
      entitlements: { arkPlus: true, circle: false },
      axes: ARKPLUS_AXES,
      feeds: [],
    })
  })

  test('session cookie + no membership → 200 free (logged-in, not a provisioning gap)', async () => {
    const token = await signSessionToken({ email: 'freebie@x.com', roles: [] }, BASE_ENV)
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` }), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'freebie@x.com',
      tier: 'free',
      ...NO_NAME,
      ...NO_PASSWORD,
      entitlements: { arkPlus: false, circle: false },
      axes: FREE_AXES,
      feeds: [],
    })
  })

  test('session cookie carrying a name → 200 with name + firstName', async () => {
    const token = await signSessionToken(
      {
        email: 'named@x.com',
        roles: [],
        givenName: 'Hannah',
        familyName: 'Waxman',
      },
      BASE_ENV,
    )
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` }), res)
    expect(res.statusCode).toBe(200)
    const body = res.__json() as { firstName: string | null }
    expect(body.firstName).toBe('Hannah')
  })

  test('a name manufactured from the email never reaches the client', async () => {
    // The shape findOrCreateAuth0User used to write. It must resolve to "no
    // name", or the greeting reads "Hi hannah.waxman8,".
    const token = await signSessionToken(
      { email: 'hannah.waxman8@x.com', roles: [], givenName: 'hannah.waxman8' },
      BASE_ENV,
    )
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` }), res)
    expect(res.statusCode).toBe(200)
    const body = res.__json() as { firstName: string | null }
    expect(body.firstName).toBeNull()
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
    membershipRows = [arkPlusRow('auth0|viabearer')]
    stripeCustomers = [{ id: 'cus_1' }]
    const token = await signCheckoutToken('viabearer@x.com', BASE_ENV)
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { tier: string }).tier).toBe('ark-plus')
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

    const token = await signAuth0Token({ email: 'newfree@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'newfree@x.com',
      tier: 'free',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: false, circle: false },
      axes: FREE_AXES,
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
    const token = await signAuth0Token({ email: 'returning@x.com' })
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

    const token = await signAuth0Token({ email: 'unlucky@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      email: 'unlucky@x.com',
      tier: 'free',
      ...NO_NAME,
      ...DB_IDENTITY,
      entitlements: { arkPlus: false, circle: false },
      axes: FREE_AXES,
      feeds: [],
    })
  })

  test('DATABASE_URL unset → auto-subscribe is skipped entirely, no Beehiiv call', async () => {
    // No DB to anchor idempotency → don't blindly write to Beehiiv every
    // request. Login still succeeds.
    const env = { ...BASE_ENV }
    delete env.DATABASE_URL
    const token = await signAuth0Token({ email: 'nodb@x.com' })
    const handler = buildHandler(env)
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect(res.statusCode).toBe(200)
    expect((res.__json() as { tier: string }).tier).toBe('free')
    expect(beehiivCalls.length).toBe(0)
  })

  test('subscriber path does NOT trigger free auto-subscribe', async () => {
    membershipRows = [arkPlusRow('auth0|paid@x.com')]
    const token = await signAuth0Token({ email: 'paid@x.com' })
    const handler = buildHandler()
    const res = makeRes()
    await runHandler(handler, makeReq({ bearer: token }), res)

    expect((res.__json() as { tier: string }).tier).toBe('ark-plus')
    expect(beehiivCalls.length).toBe(0)
    expect(
      sqlCalls.some(
        (c) => c.sql.includes('beehiiv_subscription'),
      ),
    ).toBe(false)
  })
})
