// Unit tests for the customer.subscription.* webhook handling in
// server/routes/stripe.ts — the cancel and delete paths.
//
// The arkPlus axis is Beehiiv's premium tier, which has no upstream expiry to
// mirror: a scheduled cancel is Stripe's business until the subscription is
// actually deleted, and the delete is what drops the tier. These tests pin that
// the webhook makes no upstream membership calls of its own on either event,
// which is what replaced the SC ends_at/autorenew mirror and the SC DELETE.
//
// Strategy mirrors gift.test.ts: mock.module('stripe', …) swaps the SDK for a
// fake whose webhooks.constructEvent returns a per-test `webhookEvent`;
// outbound calls go through the global fetch mock and are asserted via
// `fetchCalls`.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
  type MakeReqOpts,
} from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
let webhookEvent: unknown = null

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    // emailForStripeCustomer only calls this when sub.customer is a string;
    // our fixtures pass an object, so this is a safety net.
    retrieve: async (id: string) => ({ id, email: 'sub@example.com' }),
  }
  webhooks = {
    constructEvent: (_raw: unknown, _sig: string, _secret: string) => {
      if (!webhookEvent) throw new Error('webhookEvent not configured for this test')
      return webhookEvent
    },
  }
  subscriptions = {
    create: async () => ({}),
    update: async () => ({}),
    retrieve: async () => ({}),
    list: async () => ({ data: [] }),
  }
  paymentIntents = { create: async () => ({}), retrieve: async () => ({}), update: async () => ({}) }
  prices = { create: async () => ({}) }
  checkout = { sessions: { create: async () => ({}), retrieve: async () => ({}) } }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
// No AUTH0_* / CIRCLE_* keys → syncEntitlement short-circuits to 'skipped' and
// makes no fetch calls, and no DATABASE_URL → the Beehiiv downgrade and the
// membership row stay out of the picture. So any fetch these tests see is
// traffic the cancel/delete path issued on its own.
const BASE_ENV = {
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh_test',
}

function getHandler(path: string, env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(path)
}

// Fake req: same defaults the local helper used (POST '{}' to the webhook path).
const makeReq = (o: MakeReqOpts = {}) =>
  makeFakeReq({ method: 'POST', url: '/api/stripe/webhook', body: '{}', ...o })

// ---------------------------------------------------------------------------
// fetch mock (captures SC traffic). Tests can install a per-URL/method
// response override to simulate SC outages / 404s / etc. without rewriting
// the whole mock.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []
let responseOverride:
  | ((url: string, method: string) => Response | null)
  | null = null

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  const method = init?.method ?? 'GET'
  let parsed: unknown
  if (init?.body && typeof init.body === 'string') {
    try {
      parsed = JSON.parse(init.body)
    } catch {
      parsed = init.body
    }
  }
  fetchCalls.push({ url, method, body: parsed })
  const override = responseOverride?.(url, method)
  return override ?? new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  fetchCalls.length = 0
  webhookEvent = null
  responseOverride = null
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WEBHOOK_PATH = '/api/stripe/webhook'
const HEADERS = { 'stripe-signature': 'sig' }
// Tue, 06 May 2027 — the period-end cancel_at in unix seconds.
const CANCEL_AT = 1809599040

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    customer: { id: 'cus_1', email: 'sub@example.com' },
    metadata: { beehiiv_premium: 'true' },
    cancel_at: null,
    cancel_at_period_end: false,
    ...overrides,
  }
}

async function dispatch(event: unknown, env: Record<string, string> = BASE_ENV) {
  webhookEvent = event
  const res = makeRes()
  await runHandler(getHandler(WEBHOOK_PATH, env), makeReq({ headers: HEADERS }), res)
  return res
}

// ===========================================================================
describe('customer.subscription.updated — a scheduled cancel is not mirrored', () => {
  // Beehiiv's premium tier carries no cancel date of its own: the member holds
  // the tier — and the feed — until the subscription is actually deleted, which
  // is the event that drops it. So a scheduled cancel writes nothing upstream.
  test('scheduled cancel → no upstream membership traffic', async () => {
    const res = await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ cancel_at: CANCEL_AT, cancel_at_period_end: true }),
        previous_attributes: { cancel_at_period_end: false },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(fetchCalls).toEqual([])
  })

  test('un-cancel (cancel_at cleared) → no upstream membership traffic', async () => {
    const res = await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ cancel_at: null, cancel_at_period_end: false }),
        previous_attributes: { cancel_at: CANCEL_AT, cancel_at_period_end: true },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(fetchCalls).toEqual([])
  })

  test('metadata-only update → no upstream membership traffic', async () => {
    await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub(),
        previous_attributes: { metadata: { plan: 'yearly' } },
      },
    })
    expect(fetchCalls).toEqual([])
  })
})

describe('customer.subscription.deleted', () => {
  test('acks 200 and issues no upstream teardown call', async () => {
    // The revoke is the Beehiiv downgrade (skipped here — no DATABASE_URL), not
    // a call keyed on subscription metadata.
    const res = await dispatch({
      type: 'customer.subscription.deleted',
      data: { object: makeSub({ status: 'canceled' }) },
    })
    expect(res.statusCode).toBe(200)
    expect(fetchCalls.filter((c) => c.url.includes('api.beehiiv.com'))).toEqual([])
  })
})

// ===========================================================================
// Webhook resilience — failure-matrix integration coverage.
//
// entitlement.test.ts proves syncEntitlement isolates Auth0/Circle failures in
// isolation. These tests prove the *integration* contract at the webhook layer:
// an Auth0/Circle outage during a teardown must NOT 500 the webhook, so Stripe
// doesn't retry-storm. Recovery for the drifted Auth0/Circle legs is deferred to
// the nightly reconcile cron, not Stripe's retry.
//
// SYNC_ENV adds the Auth0 + Circle creds (BASE_ENV omits them, which is why the
// existing tests above see syncEntitlement short-circuit to 'skipped'). No
// DATABASE_URL, so the idempotency ledger and Beehiiv downgrade stay out of the
// picture and the assertions isolate the Auth0 + Circle legs.
// ===========================================================================
const SYNC_ENV = {
  ...BASE_ENV,
  AUTH0_MANAGEMENT_CLIENT_ID: 'cid',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'csec',
  AUTH0_TENANT_DOMAIN: 'https://tenant.us.auth0.com',
  CIRCLE_ADMIN_API_TOKEN: 'circle-tok',
  CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: 'ag-99',
}

describe('webhook resilience — entitlement-leg outages must not 500', () => {
  test('Auth0 + Circle both 5xx on teardown → webhook still 200', async () => {
    // FAIL-AU-01 / FAIL-CR-01 (delete trigger point): the drift is left for
    // reconcile. A 500 here would make Stripe retry the whole event
    // indefinitely.
    responseOverride = (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'mgmt-tok', expires_in: 3600 }),
          { status: 200 },
        )
      }
      if (url.includes('/users-by-email')) return new Response('{"error":"boom"}', { status: 500 })
      if (url.includes('/access_groups/ag-99/community_members')) {
        return new Response('{"error":"boom"}', { status: 500 })
      }
      return null
    }
    const res = await dispatch(
      { type: 'customer.subscription.deleted', data: { object: makeSub({ status: 'canceled' }) } },
      SYNC_ENV,
    )
    expect(res.statusCode).toBe(200)
  })
})
