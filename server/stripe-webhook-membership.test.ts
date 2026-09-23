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
// Rows reachable by Auth0 sub (the by-email lookup's second hop), the gift a
// reversal finds, and the row the term-subtraction returns.
let rowsBySub: Record<string, Record<string, unknown>> = {}
let redeemedGift: Record<string, unknown> | null = null
let giftExists = false
let rowAfterGiftRevoke: Record<string, unknown> | null = null
// An unclaimed gift the reversal path can void, and a dispute-voided one a won
// dispute can restore.
let pendingGift = false
let disputeVoidedGift = false

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      statements.push({ text, values })
      if (text.includes('insert into stripe_webhook_events')) return Promise.resolve([{ id: 'e1' }])
      if (text.includes('from membership where stripe_customer_id'))
        return Promise.resolve(priorRow ? [priorRow] : [])
      if (text.includes('from membership where auth0_sub = any')) {
        const subs = values[0] as string[]
        return Promise.resolve(subs.map((sub) => rowsBySub[sub]).filter(Boolean))
      }
      if (text.includes("update gift set status = 'reversed'")) {
        const g = redeemedGift
        redeemedGift = null // the atomic flip: only the first caller gets it
        return Promise.resolve(g ? [g] : [])
      }
      if (text.includes('select 1 from gift')) return Promise.resolve(giftExists ? [{}] : [])
      if (text.includes("update gift set status = 'void'"))
        return Promise.resolve(pendingGift ? [{ redemption_token: 't' }] : [])
      if (text.includes("update gift set status = 'pending'"))
        return Promise.resolve(disputeVoidedGift ? [{ redemption_token: 't' }] : [])
      if (text.includes('make_interval(days =>') && text.includes('update membership'))
        return Promise.resolve(rowAfterGiftRevoke ? [rowAfterGiftRevoke] : [])
      return Promise.resolve([])
    }) as unknown,
  __esModule: true,
}))

// --- Stripe mock -------------------------------------------------------------
let webhookEvent: unknown = null
const stripeCalls: Array<{ method: string; args: unknown[] }> = []
// entitlements string keyed by product id, so tierFromSubscription resolves tier.
let productEntitlements: Record<string, string> = { prod_arkplus: 'ark_plus' }

// What subscriptions.retrieve answers — the subscription's CURRENT state, which
// the handlers act on in preference to the event snapshot. 'missing' = Stripe's
// resource_missing (the subscription no longer exists).
let currentSub: unknown | 'missing' | null = null
let productLookupFails = false
// invoicePayments.list result for the refund/dispute path: the subscription the
// reversed payment's invoice belongs to, or null for "no invoice behind it".
let invoiceSubscriptionId: string | null = null

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    retrieve: async (id: string) => ({ id, email: 'buyer@example.com' }),
    list: async () => ({ data: [] }),
    createBalanceTransaction: async (id: string, args: unknown) => {
      stripeCalls.push({ method: 'customers.createBalanceTransaction', args: [id, args] })
      return { id: 'cbtxn_2' }
    },
  }
  products = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'products.retrieve', args: [id] })
      if (productLookupFails) throw new Error('stripe is having a bad day')
      return { id, metadata: { entitlements: productEntitlements[id] ?? '' } }
    },
  }
  invoicePayments = {
    list: async (args: unknown) => {
      stripeCalls.push({ method: 'invoicePayments.list', args: [args] })
      return {
        data: invoiceSubscriptionId
          ? [
              {
                invoice: {
                  id: 'in_1',
                  parent: { subscription_details: { subscription: invoiceSubscriptionId } },
                },
              },
            ]
          : [],
      }
    },
  }
  subscriptions = {
    retrieve: async (_id: string) => {
      if (currentSub === 'missing') {
        throw Object.assign(new Error('No such subscription'), {
          code: 'resource_missing',
          statusCode: 404,
        })
      }
      return currentSub ?? makeSub()
    },
    cancel: async (id: string, args: unknown) => {
      stripeCalls.push({ method: 'subscriptions.cancel', args: [id, args] })
      return { id, status: 'canceled' }
    },
    update: async (id: string, args: { metadata: Record<string, string> }) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      return makeSub()
    },
    list: async () => ({ data: [] }),
    create: async () => ({}),
  }
  paymentIntents = { create: async () => ({}), retrieve: async () => ({}), update: async () => ({}) }
  prices = { create: async () => ({}) }
  checkout = {
    sessions: {
      create: async () => ({}),
      retrieve: async () => ({}),
      update: async (id: string, args: unknown) => {
        stripeCalls.push({ method: 'checkout.sessions.update', args: [id, args] })
        return {}
      },
    },
  }
  webhooks = {
    constructEvent: () => {
      if (!webhookEvent) throw new Error('webhookEvent not configured')
      return webhookEvent
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// --- Auth0 mock: the email → user-id hop of the by-email membership lookup ----
let auth0SubsByEmail = new Map<string, string[] | null>()
mock.module('auth0', () => ({
  ManagementClient: class {
    users = {
      listUsersByEmail: ({ email }: { email: string }) => {
        const subs = auth0SubsByEmail.get(email)
        if (subs === null) return Promise.reject(new Error('auth0 down'))
        return Promise.resolve((subs ?? []).map((user_id) => ({ user_id })))
      },
    }
  },
  AuthenticationClient: class {},
  __esModule: true,
}))

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
  // Set so the dunning email actually renders and "sends"; the fetch mock keeps
  // it off the network like every other outbound call here.
  RESEND_API_KEY: 'rk_test',
}

// ENV plus an Auth0 Management client, so the by-email membership lookup walks
// its Auth0 leg (unconfigured, that leg is skipped).
const AUTH0_ENV = {
  ...ENV,
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  // Unique per file: getManagementClient caches its client per domain+client id
  // for the whole process, and `bun test` shares one process — a shared id would
  // hand this file another suite's mocked client (and its staged lookups).
  AUTH0_MANAGEMENT_CLIENT_ID: 'cid-webhook-membership',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'csec',
  AUTH0_TENANT_DOMAIN: 'https://tenant.us.auth0.com',
}

function getHandler(env: Record<string, string> = ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(WEBHOOK_PATH)
}

async function runWebhook(env: Record<string, string> = ENV): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(
    getHandler(env),
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
const fetchCalls: Array<{ url: string; method: string; init?: RequestInit }> = []
silenceExpectedConsole()
beforeEach(() => {
  statements = []
  stripeCalls.length = 0
  fetchCalls.length = 0
  priorRow = null
  rowsBySub = {}
  redeemedGift = null
  giftExists = false
  rowAfterGiftRevoke = null
  pendingGift = false
  disputeVoidedGift = false
  auth0SubsByEmail = new Map()
  currentSub = null
  productLookupFails = false
  invoiceSubscriptionId = null
  subProductId = 'prod_arkplus'
  subMeta = {}
  omitAxisMarkers = false
  productEntitlements = { prod_arkplus: 'ark_plus', prod_circle: 'circle', prod_bundle: 'ark_plus,circle' }
  webhookEvent = null
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetchCalls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      init,
    })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

function resendCalls() {
  return fetchCalls.filter((c) => c.url.includes('api.resend.com'))
}
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

  test('invoice.payment_failed also emails the member, naming their tier', async () => {
    // Without this the only signal a card failed is access disappearing weeks
    // later, when Stripe gives up — by which point replacing the card no longer
    // saves the membership.
    priorRow = { tier: 'bundle', auth0_sub: 'auth0|abc' }
    webhookEvent = {
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', customer: 'cus_1', attempt_count: 1 } },
    }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)

    const sends = resendCalls()
    expect(sends).toHaveLength(1)
    const body = JSON.parse(String(sends[0]!.init?.body)) as Record<string, unknown>
    expect(body.to).toBe('buyer@example.com')
    expect(body.subject).toBe("We couldn't process your payment")
    expect(String(body.html)).toContain('your Ark+ and Fold membership')
    expect(String(body.html)).toContain('/account/billing')
  })

  test('an unreadable tier still sends, without naming a product', async () => {
    // The membership row is where the tier comes from. Naming the wrong product
    // to someone whose card just failed is worse than naming none.
    priorRow = null
    webhookEvent = {
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_2', customer: 'cus_1', attempt_count: 1 } },
    }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(String(resendCalls()[0]!.init?.body)) as Record<string, unknown>
    expect(String(body.html)).toContain('for your membership')
  })

  test('a mail failure never 500s the webhook into a Stripe retry loop', async () => {
    // The status write has already landed. Failing the response would make
    // Stripe redeliver forever over an email that was never the point.
    priorRow = { tier: 'ark-plus', auth0_sub: 'auth0|abc' }
    webhookEvent = {
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_3', customer: 'cus_1', attempt_count: 2 } },
    }
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        init,
      })
      if (String(input).includes('api.resend.com')) {
        return new Response('{"error":"boom"}', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    const upd = statements.find((s) => s.text.includes('update membership set status'))
    expect(upd!.values).toContain('past_due')
  })

  test('subscription.deleted removes the row of a member with nothing else live', async () => {
    priorRow = SUB_ROW
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    const del = statements.find((s) => s.text.includes('delete from membership'))
    expect(del).toBeDefined()
    // Scoped to the subscription that ended, not just the customer.
    expect(del!.values).toEqual(['cus_1', 'sub_1'])
    // arkPlus is gone → the Beehiiv downgrade ran.
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(true)
  })
})

const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2001-01-01T00:00:00.000Z'
const SUB_ROW = {
  auth0_sub: 'auth0|abc',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  tier: 'ark-plus',
  status: 'active',
  current_period_end: FUTURE,
  ark_plus_gift_expires_at: null,
  circle_gift_expires_at: null,
}

// F2 — a subscription ending revokes what IT granted, and nothing else.
describe('webhook DB path — subscription ended', () => {
  test('a stale deleted for a subscription the member has since replaced is ignored', async () => {
    // They cancelled sub_1, re-subscribed (row now names sub_2), and the old
    // deleted arrives late. Acting on it would delete a paying member's row.
    priorRow = { ...SUB_ROW, stripe_subscription_id: 'sub_2' }
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(statements.some((s) => s.text.includes('delete from membership'))).toBe(false)
    expect(statements.some((s) => s.text.includes('update membership'))).toBe(false)
    expect(fetchCalls).toEqual([])
  })

  test('a live gift axis survives: the row is cleared to its gift half, not deleted', async () => {
    // Ark+ subscriber holding a live Fold gift. The subscription ends; the gift
    // was paid for by someone else and keeps running.
    priorRow = { ...SUB_ROW, circle_gift_expires_at: FUTURE }
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(statements.some((s) => s.text.includes('delete from membership'))).toBe(false)
    const clear = statements.find((s) => s.text.includes('stripe_subscription_id = null'))
    expect(clear).toBeDefined()
    // The row's tier becomes what the remaining gift axes add up to.
    expect(clear!.values).toEqual(['circle', 'cus_1', 'sub_1'])
    // The gift expiries are not in the SET list.
    expect(clear!.text).not.toContain('gift_expires_at')
    // arkPlus was the subscription's → Beehiiv premium is dropped.
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(true)
  })

  test('a live Ark+ gift keeps the premium tier — no Beehiiv downgrade', async () => {
    priorRow = { ...SUB_ROW, ark_plus_gift_expires_at: FUTURE }
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(false)
    const clear = statements.find((s) => s.text.includes('stripe_subscription_id = null'))
    expect(clear!.values[0]).toBe('ark-plus')
  })

  test('an EXPIRED gift axis keeps nothing: the row is deleted', async () => {
    priorRow = { ...SUB_ROW, circle_gift_expires_at: PAST }
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    await runWebhook()
    expect(statements.some((s) => s.text.includes('delete from membership'))).toBe(true)
  })

  test('no row for the customer, but the email holds a comp row → nothing is revoked', async () => {
    // The F1 shape: a stray subscription bought under a comped staffer's email.
    // Their row has no Stripe customer, so it is invisible by customer id; the
    // by-email check is what stops Circle/Beehiiv being revoked BY email.
    priorRow = null
    auth0SubsByEmail.set('buyer@example.com', ['auth0|staff'])
    rowsBySub = {
      'auth0|staff': {
        auth0_sub: 'auth0|staff',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        tier: 'bundle',
        status: 'active',
        current_period_end: null,
        ark_plus_gift_expires_at: null,
        circle_gift_expires_at: null,
      },
    }
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(false)
    expect(statements.some((s) => s.text.includes('delete from membership'))).toBe(false)
  })

  test('no row anywhere for the email → revoked as before', async () => {
    priorRow = null
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(true)
  })

  test('a failed by-email lookup is not read as "nothing to protect" — 500, Stripe retries', async () => {
    priorRow = null
    auth0SubsByEmail.set('buyer@example.com', null)
    webhookEvent = { type: 'customer.subscription.deleted', data: { object: makeSub() } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(500)
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(false)
  })

  test('a stale paused (resumed since) revokes nothing', async () => {
    priorRow = SUB_ROW
    // currentSub defaults to the active fixture.
    webhookEvent = { type: 'customer.subscription.paused', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(statements.some((s) => s.text.includes('delete from membership'))).toBe(false)
    expect(fetchCalls).toEqual([])
  })
})

// F3(b) — act on the subscription's CURRENT state, not the event snapshot.
describe('webhook DB path — stale snapshots', () => {
  test('an updated that arrives after the subscription was cancelled does not re-grant', async () => {
    priorRow = null // the deleted event already removed it
    currentSub = { ...(makeSub() as object), status: 'canceled' }
    webhookEvent = {
      type: 'customer.subscription.updated',
      // The snapshot still says active — that is the whole problem.
      data: { object: makeSub(), previous_attributes: { status: 'past_due' } },
    }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(upsertStmt()).toBeUndefined()
  })

  test('an updated for a subscription Stripe no longer has is treated as deleted', async () => {
    priorRow = SUB_ROW
    currentSub = 'missing'
    webhookEvent = {
      type: 'customer.subscription.updated',
      data: { object: makeSub(), previous_attributes: {} },
    }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(upsertStmt()).toBeUndefined()
    expect(statements.some((s) => s.text.includes('delete from membership'))).toBe(true)
  })

  test('the row is written from the current state, not the snapshot', async () => {
    subProductId = 'prod_bundle'
    currentSub = makeSub() // bundle, as Stripe holds it now
    subProductId = 'prod_arkplus'
    webhookEvent = { type: 'customer.subscription.created', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(upsertStmt()!.values[3]).toBe('bundle')
  })
})

// F6 — the tier comes from the price product or not at all.
describe('webhook DB path — tier authority', () => {
  test('a subscription whose product carries no entitlements is not ours: ignored', async () => {
    // Previously fell back to sub.metadata.tier, defaulting to Ark+ — so any
    // subscription on the account provisioned a membership.
    subProductId = 'prod_something_else'
    subMeta = { tier: 'bundle' }
    webhookEvent = { type: 'customer.subscription.created', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(upsertStmt()).toBeUndefined()
    expect(fetchCalls).toEqual([])
  })

  test('a foreign subscription going past_due does not mark the membership delinquent', async () => {
    subProductId = 'prod_something_else'
    currentSub = { ...(makeSub() as object), status: 'past_due' }
    webhookEvent = {
      type: 'customer.subscription.updated',
      data: { object: makeSub(), previous_attributes: {} },
    }
    await runWebhook()
    expect(statements.some((s) => s.text.includes('update membership set status'))).toBe(false)
  })

  test('a product lookup error is rethrown — 500, no Ark+ by default', async () => {
    productLookupFails = true
    webhookEvent = { type: 'customer.subscription.created', data: { object: makeSub() } }
    const res = await runWebhook()
    expect(res.statusCode).toBe(500)
    expect(upsertStmt()).toBeUndefined()
  })
})

// F5 — a reversed payment takes back what it bought.
describe('webhook DB path — refunds and disputes', () => {
  const FULL_REFUND = {
    id: 'ch_1',
    payment_intent: 'pi_1',
    refunded: true,
    amount: 800,
    amount_refunded: 800,
  }

  test('a FULL refund of a subscription payment cancels the subscription now', async () => {
    invoiceSubscriptionId = 'sub_1'
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    const cancel = stripeCalls.find((c) => c.method === 'subscriptions.cancel')
    expect(cancel).toBeDefined()
    expect(cancel!.args[0]).toBe('sub_1')
  })

  test('a PARTIAL refund leaves the subscription alone', async () => {
    invoiceSubscriptionId = 'sub_1'
    webhookEvent = {
      type: 'charge.refunded',
      data: { object: { ...FULL_REFUND, refunded: false, amount_refunded: 300 } },
    }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.cancel')).toBe(false)
  })

  test('a dispute cancels the subscription (the event object is a Dispute, not a Charge)', async () => {
    invoiceSubscriptionId = 'sub_1'
    webhookEvent = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 800 } },
    }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.cancel')).toBe(true)
  })

  test('an already-cancelled subscription is not cancelled twice', async () => {
    invoiceSubscriptionId = 'sub_1'
    currentSub = { ...(makeSub() as object), status: 'canceled' }
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.cancel')).toBe(false)
  })

  test('a payment with no subscription invoice behind it cancels nothing', async () => {
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.cancel')).toBe(false)
  })

  test('a REDEEMED gift: the term comes off the redeemer, and the log says what is left to do', async () => {
    redeemedGift = {
      redemption_token: 't',
      tier: 'ark-plus',
      plan: '6mo',
      status: 'reversed',
      redeemed_by: 'auth0|recipient',
    }
    rowAfterGiftRevoke = {
      auth0_sub: 'auth0|recipient',
      stripe_customer_id: 'cus_r',
      stripe_subscription_id: null,
      tier: 'ark-plus',
      status: 'active',
      current_period_end: null,
      ark_plus_gift_expires_at: PAST,
      circle_gift_expires_at: null,
    }
    const logged: string[] = []
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    // Even with a subscription invoice staged, a gift payment never goes looking
    // for a subscription to cancel.
    invoiceSubscriptionId = 'sub_1'
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)

    const revoke = statements.find(
      (s) => s.text.includes('update membership') && s.text.includes('make_interval(days =>'),
    )
    expect(revoke).toBeDefined()
    // arkPlus axis only, by the 6-month term, on the redeemer's row.
    expect(revoke!.values).toEqual([true, 182, false, 182, 'auth0|recipient'])
    // Nothing left live → Beehiiv premium dropped.
    expect(fetchCalls.some((c) => c.url.includes('api.beehiiv.com'))).toBe(true)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.cancel')).toBe(false)

    const line = logged.find((l) => l.includes('GIFT-REVERSED'))
    expect(line).toBeDefined()
    expect(line).toContain('MANUAL ACTION')
    // The redeemer's address is redacted, never logged whole.
    expect(line).not.toContain('buyer@example.com')
  })

  test('a PARTIAL refund leaves an unclaimed gift claimable', async () => {
    pendingGift = true
    webhookEvent = {
      type: 'charge.refunded',
      data: { object: { ...FULL_REFUND, refunded: false, amount_refunded: 300 } },
    }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(statements.some((s) => s.text.includes("update gift set status = 'void'"))).toBe(false)
  })

  test('a full refund voids an unclaimed gift as a refund; a dispute as a dispute', async () => {
    pendingGift = true
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    await runWebhook(AUTH0_ENV)
    const refundVoid = statements.find((s) => s.text.includes("update gift set status = 'void'"))
    expect(refundVoid?.values).toContain('refund')

    statements = []
    webhookEvent = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_1' } },
    }
    await runWebhook(AUTH0_ENV)
    const disputeVoid = statements.find((s) => s.text.includes("update gift set status = 'void'"))
    expect(disputeVoid?.values).toContain('dispute')
  })

  test('a WON dispute puts a dispute-voided gift back to pending', async () => {
    disputeVoidedGift = true
    webhookEvent = {
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', payment_intent: 'pi_1', status: 'won' } },
    }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    const restore = statements.find((s) => s.text.includes("update gift set status = 'pending'"))
    expect(restore).toBeDefined()
    // Only a dispute void is restored, never a refund one.
    expect(restore!.text).toContain("void_reason = 'dispute'")
  })

  test('a LOST dispute restores nothing', async () => {
    disputeVoidedGift = true
    webhookEvent = {
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', payment_intent: 'pi_1', status: 'lost' } },
    }
    await runWebhook(AUTH0_ENV)
    expect(statements.some((s) => s.text.includes("update gift set status = 'pending'"))).toBe(
      false,
    )
  })

  test('a reversed gift that credited a balance debits it back', async () => {
    redeemedGift = {
      redemption_token: 't',
      tier: 'circle',
      plan: '1yr',
      status: 'reversed',
      redeemed_by: 'auth0|recipient',
      stripe_effect: {
        kind: 'credit',
        customer_id: 'cus_r',
        balance_transaction_id: 'cbtxn_1',
        amount: 19000,
        currency: 'eur',
      },
    }
    const logged: string[] = []
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    const debit = stripeCalls.find((c) => c.method === 'customers.createBalanceTransaction')
    expect(debit?.args[0]).toBe('cus_r')
    expect(debit?.args[1]).toMatchObject({ amount: 19000, currency: 'eur' })
    const line = logged.find((l) => l.includes('GIFT-REVERSED'))
    expect(line).toContain('was reversed')
    expect(line).not.toContain('MANUAL ACTION')
  })

  test('a reversed gift that pushed an annual renewal ends the pushed trial', async () => {
    const future = Math.floor(Date.now() / 1000) + 30 * 86400
    currentSub = {
      ...(makeSub() as object),
      id: 'sub_r',
      status: 'trialing',
      trial_end: future + 365 * 86400,
    }
    redeemedGift = {
      redemption_token: 't',
      tier: 'ark-plus',
      plan: '1yr',
      status: 'reversed',
      redeemed_by: 'auth0|recipient',
      stripe_effect: {
        kind: 'trial_end',
        subscription_id: 'sub_r',
        previous_period_end: future,
        trial_end: future + 365 * 86400,
      },
    }
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    const update = stripeCalls.find(
      (c) => c.method === 'subscriptions.update' && c.args[0] === 'sub_r',
    )
    expect(update?.args[1]).toMatchObject({ trial_end: future, proration_behavior: 'none' })
  })

  test('a reversed gift whose subscription moved on since is left for a human', async () => {
    currentSub = { ...(makeSub() as object), id: 'sub_r', status: 'active', trial_end: null }
    redeemedGift = {
      redemption_token: 't',
      tier: 'ark-plus',
      plan: '1yr',
      status: 'reversed',
      redeemed_by: 'auth0|recipient',
      stripe_effect: {
        kind: 'trial_end',
        subscription_id: 'sub_r',
        previous_period_end: 1,
        trial_end: 2,
      },
    }
    const logged: string[] = []
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    webhookEvent = { type: 'charge.refunded', data: { object: FULL_REFUND } }
    await runWebhook(AUTH0_ENV)
    expect(
      stripeCalls.some((c) => c.method === 'subscriptions.update' && c.args[0] === 'sub_r'),
    ).toBe(false)
    expect(logged.find((l) => l.includes('GIFT-REVERSED'))).toContain('MANUAL ACTION')
  })

  test('a second reversal event for the same gift takes nothing more off', async () => {
    redeemedGift = null // already flipped to 'reversed' by the first event
    giftExists = true
    invoiceSubscriptionId = 'sub_1'
    webhookEvent = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_1' } },
    }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    expect(
      statements.some((s) => s.text.includes('update membership') && s.text.includes('make_interval')),
    ).toBe(false)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.cancel')).toBe(false)
  })
})

// A 100%-off promo leaves a $0 payment-mode Session with no PaymentIntent, so
// checkout.session.completed is the only signal the gift was bought.
describe('webhook DB path — a free (fully discounted) gift', () => {
  const FREE_GIFT_SESSION = {
    id: 'cs_free',
    mode: 'payment',
    payment_status: 'no_payment_required',
    amount_total: 0,
    currency: 'eur',
    metadata: {
      kind: 'gift',
      tier: 'circle',
      term: '6mo',
      currency: 'eur',
      giver_email: 'giver@example.com',
      recipient_email: 'friend@example.com',
      recipient_name: 'Friend',
    },
  }

  test('issues the gift from the Session: a pending row, the claim email, the Session stamped', async () => {
    webhookEvent = { type: 'checkout.session.completed', data: { object: FREE_GIFT_SESSION } }
    const res = await runWebhook(AUTH0_ENV)
    expect(res.statusCode).toBe(200)
    const insert = statements.find((s) => s.text.includes('insert into gift'))
    expect(insert).toBeDefined()
    expect(insert!.values).toContain('circle')
    expect(insert!.values).toContain('6mo')
    expect(insert!.values).toContain(0)
    expect(resendCalls().length).toBe(1)
    const stamp = stripeCalls.find((c) => c.method === 'checkout.sessions.update')
    expect(stamp?.args[0]).toBe('cs_free')
    expect((stamp?.args[1] as { metadata: Record<string, string> }).metadata.gift_token).toBeTruthy()
  })

  test('a PAID gift Session is left to payment_intent.succeeded', async () => {
    webhookEvent = {
      type: 'checkout.session.completed',
      data: { object: { ...FREE_GIFT_SESSION, payment_status: 'paid', amount_total: 11400 } },
    }
    await runWebhook(AUTH0_ENV)
    expect(statements.some((s) => s.text.includes('insert into gift'))).toBe(false)
    expect(resendCalls().length).toBe(0)
  })

  test('a subscription Session is not a gift', async () => {
    webhookEvent = {
      type: 'checkout.session.completed',
      data: { object: { ...FREE_GIFT_SESSION, mode: 'subscription', metadata: {} } },
    }
    await runWebhook(AUTH0_ENV)
    expect(statements.some((s) => s.text.includes('insert into gift'))).toBe(false)
  })
})
