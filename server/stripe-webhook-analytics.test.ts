/// <reference types="bun" />
// Integration tests for the two server-side events the Stripe webhook emits.
// What is pinned here is the *mapping* — which Stripe event produces which
// analytics event, with which properties — not the transport (covered in
// analytics-server.test.ts).
//
// Deliberately absent: renewals, refunds, dunning, churn and tier changes. All
// of those live in Stripe Billing, reconciled to the ledger, and were removed
// rather than duplicated here (see server/lib/analytics-server.ts). If a test
// for one of them ever reappears, something has been added back that shouldn't
// have been.
//
// The load-bearing property: nothing here may 500 the webhook. A metrics
// failure that traps events in a Stripe retry loop is far worse than a missing
// datapoint.
//
// Harness mirrors stripe-webhook.test.ts: mock.module('stripe', …) swaps the SDK
// for a fake whose webhooks.constructEvent returns a per-test `webhookEvent`;
// all outbound HTTP (SC and PostHog alike) goes through the global fetch mock.

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
  products = {
    // The tier authority: the price product's `entitlements` metadata.
    retrieve: async (id: string) => ({ id, metadata: { entitlements: 'ark_plus' } }),
  }
  prices = { create: async () => ({}) }
  charges = { retrieve: async () => ({}) }
  checkout = { sessions: { create: async () => ({}), retrieve: async () => ({}) } }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
// No DATABASE_URL: exercises the no-store path, which still provisions and
// still must emit. No AUTH0_*/CIRCLE_* keys → syncEntitlement short-circuits, so
// the only fetch traffic is SC and PostHog.
const BASE_ENV = {
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-key',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh_test',
  POSTHOG_API_KEY: 'phc_test',
  VERCEL_ENV: 'production',
}

const WEBHOOK_PATH = '/api/stripe/webhook'
const HEADERS = { 'stripe-signature': 'sig' }
const POSTHOG_URL = 'https://us.i.posthog.com/i/v0/e/'

// SHA-256('sub@example.com') — the distinct_id every event below should carry,
// identical to what the browser's hashEmail() produces for the same member.
const SUB_EMAIL_HASH =
  '9fd69e4cf4b7106357ce610c8f0031c2a9df017556afeac3ed34989edcdb56ef'

function getHandler(env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(WEBHOOK_PATH)
}

const makeReq = (o: MakeReqOpts = {}) =>
  makeFakeReq({ method: 'POST', url: WEBHOOK_PATH, body: '{}', ...o })

const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
let responseOverride: ((url: string, method: string) => Response | null) | null = null

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  const method = init?.method ?? 'GET'
  let parsed: Record<string, unknown> = {}
  if (init?.body && typeof init.body === 'string') {
    try {
      parsed = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      /* non-JSON body — irrelevant to these assertions */
    }
  }
  fetchCalls.push({ url, method, body: parsed })
  return responseOverride?.(url, method) ?? new Response('{}', { status: 200 })
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
// Helpers
// ---------------------------------------------------------------------------
async function dispatch(event: unknown, env: Record<string, string> = BASE_ENV) {
  webhookEvent = event
  const res = makeRes()
  await runHandler(getHandler(env), makeReq({ headers: HEADERS }), res)
  return res
}

/** Every PostHog capture the dispatch produced, in order. */
function analytics(): Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }> {
  return fetchCalls
    .filter((c) => c.url === POSTHOG_URL)
    .map((c) => ({
      event: c.body.event as string,
      distinct_id: c.body.distinct_id as string,
      properties: c.body.properties as Record<string, unknown>,
    }))
}

const findEvent = (name: string) => analytics().find((a) => a.event === name)

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    currency: 'usd',
    customer: { id: 'cus_1', email: 'sub@example.com' },
    metadata: { sc_subscription_id: '3119346' },
    items: {
      data: [
        {
          id: 'si_1',
          price: {
            id: 'price_1',
            product: 'prod_1',
            unit_amount: 5999,
            recurring: { interval: 'year' },
          },
        },
      ],
    },
    cancel_at: null,
    cancel_at_period_end: false,
    ...overrides,
  }
}

// ===========================================================================
describe('customer.subscription.created → subscription_started_confirmed', () => {
  test('emits the confirmed conversion with tier, plan, amount and currency', async () => {
    const res = await dispatch({
      type: 'customer.subscription.created',
      data: { object: makeSub() },
    })

    expect(res.statusCode).toBe(200)
    const started = findEvent('subscription_started_confirmed')
    expect(started).toBeDefined()
    expect(started!.distinct_id).toBe(SUB_EMAIL_HASH)
    expect(started!.properties.tier).toBe('ark-plus')
    expect(started!.properties.plan).toBe('yearly')
    expect(started!.properties.amount_cents).toBe(5999)
    expect(started!.properties.currency).toBe('usd')
  })

  test('also emits member_provisioned, so "paid" and "got access" stay distinct', async () => {
    await dispatch({ type: 'customer.subscription.created', data: { object: makeSub() } })
    const provisioned = findEvent('member_provisioned')
    expect(provisioned).toBeDefined()
    expect(provisioned!.properties.axes).toBe('ark-plus')
  })

  test('forwards the attribution stamped on the subscription at checkout', async () => {
    await dispatch({
      type: 'customer.subscription.created',
      data: {
        object: makeSub({
          metadata: {
            sc_subscription_id: '3119346',
            first_touch_source: 'cmb-ep412',
            first_touch_medium: 'referral',
            last_touch_source: 'newsletter',
          },
        }),
      },
    })
    const started = findEvent('subscription_started_confirmed')!
    expect(started.properties.first_touch_source).toBe('cmb-ep412')
    expect(started.properties.first_touch_medium).toBe('referral')
    expect(started.properties.last_touch_source).toBe('newsletter')
  })

  test('an inactive subscription emits nothing — there is no conversion yet', async () => {
    await dispatch({
      type: 'customer.subscription.created',
      data: { object: makeSub({ status: 'incomplete' }) },
    })
    expect(analytics()).toEqual([])
  })
})

// ===========================================================================
describe('analytics never breaks the webhook', () => {
  test('PostHog 5xx → webhook still 200', async () => {
    responseOverride = (url) =>
      url === POSTHOG_URL ? new Response('down', { status: 503 }) : null
    const res = await dispatch({
      type: 'customer.subscription.created',
      data: { object: makeSub() },
    })
    expect(res.statusCode).toBe(200)
  })

  test('no POSTHOG_API_KEY → no capture traffic at all, webhook unaffected', async () => {
    const { POSTHOG_API_KEY: _omitted, ...envWithoutKey } = BASE_ENV
    const res = await dispatch(
      { type: 'customer.subscription.created', data: { object: makeSub() } },
      envWithoutKey,
    )
    expect(res.statusCode).toBe(200)
    expect(analytics()).toEqual([])
  })
})
