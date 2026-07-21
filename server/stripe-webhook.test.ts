// Unit tests for the customer.subscription.* webhook handling in
// server/routes/stripe.ts — specifically the SC cancel-schedule mirroring
// (ends_at / autorenew) and the existing delete path.
//
// Strategy mirrors gift.test.ts: mock.module('stripe', …) swaps the SDK for a
// fake whose webhooks.constructEvent returns a per-test `webhookEvent`; SC
// calls go through the global fetch mock and are asserted via `fetchCalls`.

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
// makes no fetch calls, so the only SC traffic in these tests is the cancel-
// schedule PATCH / delete DELETE we're asserting on.
const BASE_ENV = {
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-key',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh_test',
}

const SC_BASE = 'https://api.supportingcast.fm/v2/test-net'

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
    metadata: { sc_subscription_id: '3119346' },
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

const scPatches = () =>
  fetchCalls.filter((c) => c.method === 'PATCH' && c.url === `${SC_BASE}/subscriptions/3119346`)

// ===========================================================================
describe('customer.subscription.updated — SC cancel-schedule mirroring', () => {
  test('scheduled cancel → PATCH ends_at + autorenew:false', async () => {
    const res = await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ cancel_at: CANCEL_AT, cancel_at_period_end: true }),
        previous_attributes: { cancel_at_period_end: false },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(scPatches()).toHaveLength(1)
    expect(scPatches()[0]!.body).toEqual({
      ends_at: new Date(CANCEL_AT * 1000).toISOString(),
      autorenew: false,
    })
  })

  test('un-cancel (cancel_at cleared) → PATCH ends_at:null + autorenew:true', async () => {
    await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ cancel_at: null, cancel_at_period_end: false }),
        previous_attributes: { cancel_at: CANCEL_AT, cancel_at_period_end: true },
      },
    })
    expect(scPatches()).toHaveLength(1)
    expect(scPatches()[0]!.body).toEqual({ ends_at: null, autorenew: true })
  })

  test('metadata-only update (no cancel fields changed) → no SC PATCH', async () => {
    await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub(),
        previous_attributes: { metadata: { plan: 'yearly' } },
      },
    })
    expect(scPatches()).toHaveLength(0)
  })

  test('cancel scheduled but no sc_subscription_id metadata → no SC PATCH', async () => {
    // status:'incomplete' keeps the activator from running so this test
    // genuinely exercises only the missing-metadata guard (otherwise the
    // PATCH=0 assertion passes for the wrong reason — activator traffic).
    await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({
          status: 'incomplete',
          metadata: {},
          cancel_at: CANCEL_AT,
          cancel_at_period_end: true,
        }),
        previous_attributes: { cancel_at_period_end: false },
      },
    })
    expect(fetchCalls).toEqual([])
  })

  test('SC PATCH returns 404 (webhook reorder) → handler still 200', async () => {
    // If customer.subscription.deleted arrives before customer.subscription.updated,
    // the SC sub has already been DELETE'd. The mirror PATCH then 404s.
    // The handler must still return 200 (Stripe will otherwise retry forever).
    responseOverride = (url, method) =>
      method === 'PATCH' && url === `${SC_BASE}/subscriptions/3119346`
        ? new Response('{}', { status: 404 })
        : null
    const res = await dispatch({
      type: 'customer.subscription.updated',
      data: {
        object: makeSub({ cancel_at: CANCEL_AT, cancel_at_period_end: true }),
        previous_attributes: { cancel_at_period_end: false },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(scPatches()).toHaveLength(1)
  })
})

describe('customer.subscription.deleted — SC delete (existing behavior)', () => {
  test('deletes the SC subscription by metadata id', async () => {
    const res = await dispatch({
      type: 'customer.subscription.deleted',
      data: { object: makeSub({ status: 'canceled' }) },
    })
    expect(res.statusCode).toBe(200)
    const deletes = fetchCalls.filter(
      (c) => c.method === 'DELETE' && c.url === `${SC_BASE}/subscriptions/3119346`,
    )
    expect(deletes).toHaveLength(1)
  })
})

// ===========================================================================
// Webhook resilience — failure-matrix integration coverage.
//
// entitlement.test.ts proves syncEntitlement isolates Auth0/Circle failures in
// isolation. These tests prove the *integration* contract at the webhook layer:
// an Auth0/Circle outage during a state change must NOT 500 the webhook (so
// Stripe doesn't retry-storm), and the SC teardown of the paid product still
// proceeds. Recovery for the drifted Auth0/Circle legs is deferred to the
// nightly reconcile cron, not Stripe's retry.
//
// SYNC_ENV adds the Auth0 + Circle creds (BASE_ENV omits them, which is why the
// existing tests above see syncEntitlement short-circuit to 'skipped'). No
// DATABASE_URL, so the idempotency ledger and Beehiiv downgrade stay out of the
// picture and the assertions isolate the SC + Auth0 + Circle legs.
// ===========================================================================
const SYNC_ENV = {
  ...BASE_ENV,
  AUTH0_MANAGEMENT_CLIENT_ID: 'cid',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'csec',
  AUTH0_TENANT_DOMAIN: 'https://tenant.us.auth0.com',
  CIRCLE_API_TOKEN: 'circle-tok',
  CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: 'ag-99',
}

const scDeletes = () =>
  fetchCalls.filter(
    (c) => c.method === 'DELETE' && c.url === `${SC_BASE}/subscriptions/3119346`,
  )

describe('webhook resilience — entitlement-leg outages must not 500', () => {
  test('Auth0 + Circle both 5xx on teardown → webhook still 200, SC delete still issued', async () => {
    // FAIL-AU-01 / FAIL-CR-01 (delete trigger point): the paid product (SC) is
    // torn down; the Auth0/Circle drift is left for reconcile. A 500 here would
    // make Stripe retry the whole event indefinitely.
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
      return null // SC delete falls through to the default 200
    }
    const res = await dispatch(
      { type: 'customer.subscription.deleted', data: { object: makeSub({ status: 'canceled' }) } },
      SYNC_ENV,
    )
    expect(res.statusCode).toBe(200)
    expect(scDeletes()).toHaveLength(1)
  })

  test('SC delete itself 5xx → webhook still 200 (soft-fail; documents the over-entitlement gap)', async () => {
    // FAIL-SC-03: the reconciler never touches Simplecast (see stripe.ts
    // comment), so a permanently-failing SC DELETE leaves the member with paid
    // feed access and NO automatic recovery. The webhook must still 200 (Stripe
    // retry won't fix a 5xx-on-our-side SC call), but this drift needs
    // monitoring + manual cleanup — it is the highest-severity sync risk.
    responseOverride = (url, method) =>
      method === 'DELETE' && url === `${SC_BASE}/subscriptions/3119346`
        ? new Response('{"error":"sc down"}', { status: 500 })
        : null
    const res = await dispatch({
      type: 'customer.subscription.deleted',
      data: { object: makeSub({ status: 'canceled' }) },
    })
    expect(res.statusCode).toBe(200)
    expect(scDeletes()).toHaveLength(1)
  })
})
