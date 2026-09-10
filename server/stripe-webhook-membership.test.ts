// Task 9: the DB-backed webhook path — tier from the price product, the
// entitlement-diff fan-out gate, the Neon membership-row write, dunning, and
// cancel deletion. stripe-webhook.test.ts runs WITHOUT DATABASE_URL (the
// pre-task-9 path); this file stands up a mocked neon client so the membership
// logic is exercised.
//
// Auth0/Circle are unconfigured (syncEntitlement short-circuits to 'skipped'),
// and the fixture sub is pre-stamped with provisioning markers so the activator
// fast-paths (no live Auth0/SC needed) and the webhook reads auth0_sub off the
// metadata for the row.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
  type FakeRes,
} from './test-utils'

// --- neon mock: record statements + values, stage a prior membership row ------
type Stmt = { text: string; values: unknown[] }
let statements: Stmt[] = []
let priorRow: Record<string, unknown> | null = null

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      statements.push({ text, values })
      if (text.includes('insert into stripe_webhook_events')) return Promise.resolve([{ id: 'e1' }])
      if (text.includes('from membership where stripe_customer_id'))
        return Promise.resolve(priorRow ? [priorRow] : [])
      return Promise.resolve([])
    }) as unknown,
  __esModule: true,
}))

// --- Stripe mock -------------------------------------------------------------
let webhookEvent: unknown = null
const stripeCalls: Array<{ method: string; args: unknown[] }> = []
// entitlements string keyed by product id, so tierFromSubscription resolves tier.
let productEntitlements: Record<string, string> = { prod_arkplus: 'ark_plus' }

class FakeStripe {
  constructor(_key: string) {}
  customers = { retrieve: async (id: string) => ({ id, email: 'buyer@example.com' }) }
  products = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'products.retrieve', args: [id] })
      return { id, metadata: { entitlements: productEntitlements[id] ?? '' } }
    },
  }
  subscriptions = {
    retrieve: async (_id: string) => makeSub(),
    update: async (id: string, args: { metadata: Record<string, string> }) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      return makeSub()
    },
    list: async () => ({ data: [] }),
    create: async () => ({}),
  }
  paymentIntents = { create: async () => ({}), retrieve: async () => ({}), update: async () => ({}) }
  prices = { create: async () => ({}) }
  checkout = { sessions: { create: async () => ({}), retrieve: async () => ({}) } }
  webhooks = {
    constructEvent: () => {
      if (!webhookEvent) throw new Error('webhookEvent not configured')
      return webhookEvent
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

import { devApiPlugin } from './dev-api'

// --- fixtures ----------------------------------------------------------------
// A fully-provisioned Ark+ sub: the activator fast-paths off these markers and
// the webhook reads auth0_user_id for the row. Product id drives the tier.
let subProductId = 'prod_arkplus'
let subMeta: Record<string, string> = {}
// Drop the axis provisioning markers (keeping auth0_user_id) so the activator
// actually attempts the Beehiiv premium grant instead of fast-pathing.
let omitAxisMarkers = false

function makeSub(): unknown {
  const metadata: Record<string, string> = omitAxisMarkers
    ? { plan: 'monthly', auth0_user_id: 'auth0|abc', ...subMeta }
    : {
        plan: 'monthly',
        auth0_user_id: 'auth0|abc',
        beehiiv_premium: 'true',
        circle_provisioned: 'true',
        ...subMeta,
      }
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at: null,
    metadata,
    items: {
      data: [
        {
          current_period_end: 1893456000,
          price: {
            product: subProductId,
            unit_amount: 800,
            recurring: { interval: 'month' },
          },
        },
      ],
    },
  }
}

// --- harness -----------------------------------------------------------------
const WEBHOOK_PATH = '/api/stripe/webhook'

const ENV = {
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh',
  DATABASE_URL: 'postgres://stub-membership-test',
  BEEHIIV_API_KEY: 'bh_key',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test',
  BEEHIIV_PREMIUM_TIER_ID: 'tier_plus',
}

function getHandler(): Middleware {
  return createDevApiHarness(devApiPlugin(ENV)).getHandler(WEBHOOK_PATH)
}

async function runWebhook(): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(
    getHandler(),
    makeFakeReq({
      method: 'POST',
      url: WEBHOOK_PATH,
      body: '{}',
      headers: { 'stripe-signature': 'sig' },
    }),
    res,
  )
  return res
}

const globalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string }> = []
silenceExpectedConsole()
beforeEach(() => {
  statements = []
  stripeCalls.length = 0
  fetchCalls.length = 0
  priorRow = null
  subProductId = 'prod_arkplus'
  subMeta = {}
  omitAxisMarkers = false
  productEntitlements = { prod_arkplus: 'ark_plus', prod_circle: 'circle', prod_bundle: 'ark_plus,circle' }
  webhookEvent = null
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globalFetch
})

function upsertStmt(): Stmt | undefined {
  return statements.find((s) => s.text.includes('insert into membership'))
}

describe('webhook DB path — membership row', () => {
  test('subscription.created (Ark+) writes a membership row with tier + status', async () => {
    webhookEvent = { type: 'customer.subscription.created', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    const up = upsertStmt()
    expect(up).toBeDefined()
    // values: auth0_sub, customer, sub, tier, status, plan, amount, ...
    expect(up!.values[0]).toBe('auth0|abc')
    expect(up!.values[3]).toBe('ark-plus')
    expect(up!.values[4]).toBe('active')
  })

  test('a failed Beehiiv grant is not acked — no membership row, Stripe retries', async () => {
    // The premium tier IS the arkPlus grant, so it cannot be best-effort: a
    // member whose grant failed must not get a row telling the rest of the app
    // they have the feed. Surfacing the failure is what makes Stripe redeliver
    // and the grant retry.
    omitAxisMarkers = true // force the activator to attempt the grant
    webhookEvent = { type: 'customer.subscription.created', data: { object: makeSub() } }
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      fetchCalls.push({ url, method })
      if (url.includes('/subscriptions/by_email/')) {
        return new Response('{"error":"not found"}', { status: 404 })
      }
      if (url.includes('api.beehiiv.com') && url.endsWith('/subscriptions')) {
        return new Response('{"error":"beehiiv down"}', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const res = await runWebhook()

    expect(res.statusCode).toBe(500)
    expect(upsertStmt()).toBeUndefined()
  })

  test('Circle-only sub resolves tier=circle and never grants the premium tier', async () => {
    subProductId = 'prod_circle'
    subMeta = { circle_provisioned: 'true', auth0_user_id: 'auth0|abc' }
    webhookEvent = { type: 'customer.subscription.created', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(upsertStmt()!.values[3]).toBe('circle')
    // Nothing reached Beehiiv: the circle axis carries no premium tier.
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(false)
  })

  test('metadata-only update on a same-tier provisioned sub does not re-provision', async () => {
    priorRow = { tier: 'ark-plus', stripe_customer_id: 'cus_1' }
    webhookEvent = {
      type: 'customer.subscription.updated',
      data: { object: makeSub(), previous_attributes: { metadata: { plan: 'monthly' } } },
    }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    // Fast-path: no SC/Auth0/Circle network calls fired for provisioning.
    expect(fetchCalls.length).toBe(0)
    // Row is still refreshed.
    expect(upsertStmt()).toBeDefined()
  })

  test('invoice.payment_failed marks the row past_due (dunning)', async () => {
    webhookEvent = {
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', customer: 'cus_1' } },
    }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    const upd = statements.find((s) => s.text.includes('update membership set status'))
    expect(upd).toBeDefined()
    expect(upd!.values).toContain('past_due')
  })

  test('subscription.deleted removes the membership row', async () => {
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(statements.some((s) => s.text.includes('delete from membership'))).toBe(true)
  })
})
