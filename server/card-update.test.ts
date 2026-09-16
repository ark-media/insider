// Unit tests for the billing page's card update, the two routes either side of
// Stripe's own confirmation:
//
//   POST /api/stripe/card-setup-intent — a card-only SetupIntent on the session
//   member's own customer, rate-limited per member.
//
//   POST /api/stripe/update-card — bills the membership to the card on a
//   confirmed SetupIntent. The guards are the point: the intent must belong to
//   the session member's customer and must have succeeded, and the card comes
//   off the intent rather than the request body.
//
// Harness mirrors my-subscription.test.ts: mock.module('stripe', …) swaps the
// SDK, and we drive the registered middleware with fake req/res.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
  type FakeRes,
} from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []

let existingCustomers: Array<{ id: string; email: string }> = []
let subsByCustomer: Record<string, Array<{ id: string; schedule?: string | null }>> = {}
// SetupIntents setupIntents.retrieve can find, by id.
let setupIntents: Record<
  string,
  {
    customer: string
    status: string
    payment_method: {
      id: string
      card?: { brand: string; last4: string; exp_month: number; exp_year: number }
    } | null
  }
> = {}
// Makes subscriptions.update throw, to model a Stripe failure mid-save.
let failSubscriptionUpdate = false

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return { data: existingCustomers.filter((c) => c.email === args.email) }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'customers.update', args: [id, args] })
      return { id }
    },
  }
  subscriptions = {
    list: async (args: { customer: string; status?: string; limit?: number }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      const subs = (subsByCustomer[args.customer] ?? []).map((s) => ({
        id: s.id,
        customer: args.customer,
        status: 'active',
        schedule: s.schedule ?? null,
        items: { data: [] },
      }))
      return { data: subs }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      if (failSubscriptionUpdate) throw new Error('stripe is down')
      return { id }
    },
  }
  subscriptionSchedules = {
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptionSchedules.update', args: [id, args] })
      return { id }
    },
  }
  setupIntents = {
    create: async (args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'setupIntents.create', args: [args] })
      return { id: 'seti_new', client_secret: 'seti_new_secret_abc' }
    },
    retrieve: async (id: string, args?: Record<string, unknown>) => {
      stripeCalls.push({ method: 'setupIntents.retrieve', args: [id, args] })
      const intent = setupIntents[id]
      if (!intent) throw new Error('No such setupintent')
      return { id, ...intent }
    },
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const SETUP_PATH = '/api/stripe/card-setup-intent'
const UPDATE_PATH = '/api/stripe/update-card'

function getHandler(path: string): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(path)
}

silenceExpectedConsole()
beforeEach(() => {
  stripeCalls.length = 0
  existingCustomers = []
  subsByCustomer = {}
  setupIntents = {}
  failSubscriptionUpdate = false
})

async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function post(
  path: string,
  opts: { body?: unknown; cookie?: string; origin?: string; handler?: Middleware } = {},
): Promise<FakeRes> {
  const res = makeRes()
  const headers: Record<string, string> = {}
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.origin) headers.origin = opts.origin
  await runHandler(
    opts.handler ?? getHandler(path),
    makeFakeReq({ method: 'POST', url: path, body: opts.body, headers }),
    res,
  )
  return res
}

const writes = () =>
  stripeCalls.filter((c) =>
    ['subscriptions.update', 'customers.update', 'subscriptionSchedules.update'].includes(
      c.method,
    ),
  )

const VISA = { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 }

function memberWithSub(opts: { schedule?: string } = {}) {
  existingCustomers = [{ id: 'cus_me', email: 'member@example.com' }]
  subsByCustomer = { cus_me: [{ id: 'sub_me', schedule: opts.schedule ?? null }] }
}

// ===========================================================================
describe('POST /api/stripe/card-setup-intent', () => {
  test('403 when the Origin does not match APP_BASE_URL', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await post(SETUP_PATH, { cookie, origin: 'http://evil.example' })
    expect(res.statusCode).toBe(403)
    expect(stripeCalls.length).toBe(0)
  })

  test('401 when unauthenticated', async () => {
    const res = await post(SETUP_PATH)
    expect(res.statusCode).toBe(401)
    expect(stripeCalls.length).toBe(0)
  })

  test('404 when the member has no live subscription', async () => {
    existingCustomers = [{ id: 'cus_me', email: 'member@example.com' }]
    const cookie = await sessionCookie('member@example.com')
    const res = await post(SETUP_PATH, { cookie })
    expect(res.statusCode).toBe(404)
    expect(stripeCalls.find((c) => c.method === 'setupIntents.create')).toBeUndefined()
  })

  test("creates a card-only intent on the subscription's customer", async () => {
    memberWithSub()
    const cookie = await sessionCookie('member@example.com')
    const res = await post(SETUP_PATH, { cookie })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ clientSecret: 'seti_new_secret_abc' })

    const create = stripeCalls.find((c) => c.method === 'setupIntents.create')
    expect(create!.args[0]).toEqual({
      customer: 'cus_me',
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { kind: 'card_update', subscription: 'sub_me' },
    })
    // Creating the intent changes nothing about the membership on its own.
    expect(writes()).toEqual([])
  })

  test('429 once a member has opened the form ten times in the hour', async () => {
    memberWithSub()
    const cookie = await sessionCookie('member@example.com')
    // One registered handler, so every call shares its limiter.
    const handler = getHandler(SETUP_PATH)
    for (let i = 0; i < 10; i++) {
      expect((await post(SETUP_PATH, { cookie, handler })).statusCode).toBe(200)
    }
    const res = await post(SETUP_PATH, { cookie, handler })
    expect(res.statusCode).toBe(429)
    expect(res.__headers()['retry-after']).toBeTruthy()
    expect(stripeCalls.filter((c) => c.method === 'setupIntents.create').length).toBe(10)
  })
})

// ===========================================================================
describe('POST /api/stripe/update-card — guards', () => {
  test('403 when the Origin does not match APP_BASE_URL', async () => {
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, {
      cookie,
      origin: 'http://evil.example',
      body: { setup_intent_id: 'seti_1' },
    })
    expect(res.statusCode).toBe(403)
    expect(stripeCalls.length).toBe(0)
  })

  test('401 when unauthenticated', async () => {
    const res = await post(UPDATE_PATH, { body: { setup_intent_id: 'seti_1' } })
    expect(res.statusCode).toBe(401)
    expect(stripeCalls.length).toBe(0)
  })

  test('400 without a SetupIntent id — a bare payment method id is not accepted', async () => {
    memberWithSub()
    const cookie = await sessionCookie('member@example.com')
    for (const body of [{}, { setup_intent_id: 42 }, { setup_intent_id: 'pm_1' }]) {
      const res = await post(UPDATE_PATH, { cookie, body })
      expect(res.statusCode).toBe(400)
    }
    expect(stripeCalls.length).toBe(0)
  })

  test("404 for another customer's intent, and nothing is written", async () => {
    memberWithSub()
    setupIntents = {
      seti_theirs: {
        customer: 'cus_someone_else',
        status: 'succeeded',
        payment_method: { id: 'pm_theirs', card: VISA },
      },
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_theirs' } })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  test('404 for an intent Stripe does not know', async () => {
    memberWithSub()
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_missing' } })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  test('409 for an intent that has not succeeded', async () => {
    memberWithSub()
    setupIntents = {
      seti_pending: {
        customer: 'cus_me',
        status: 'requires_action',
        payment_method: { id: 'pm_new', card: VISA },
      },
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_pending' } })
    expect(res.statusCode).toBe(409)
    expect(writes()).toEqual([])
  })

  test('404 when the member has no live subscription', async () => {
    existingCustomers = [{ id: 'cus_me', email: 'member@example.com' }]
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_1' } })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })
})

// ===========================================================================
describe('POST /api/stripe/update-card — saving', () => {
  test('points the subscription and the customer at the new card, and returns it', async () => {
    memberWithSub()
    setupIntents = {
      seti_ok: {
        customer: 'cus_me',
        status: 'succeeded',
        payment_method: { id: 'pm_new', card: VISA },
      },
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_ok' } })

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      ok: true,
      card: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 },
    })
    expect(writes()).toEqual([
      {
        method: 'subscriptions.update',
        args: ['sub_me', { default_payment_method: 'pm_new' }],
      },
      {
        method: 'customers.update',
        args: ['cus_me', { invoice_settings: { default_payment_method: 'pm_new' } }],
      },
    ])
  })

  test("a pending change's schedule moves to the new card too, before the subscription", async () => {
    // The schedule holds its own copy of the card and re-applies it when the
    // change lands — the date the member is next charged.
    memberWithSub({ schedule: 'sub_sched_1' })
    setupIntents = {
      seti_ok: {
        customer: 'cus_me',
        status: 'succeeded',
        payment_method: { id: 'pm_new', card: VISA },
      },
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_ok' } })

    expect(res.statusCode).toBe(200)
    expect(writes().map((c) => c.method)).toEqual([
      'subscriptionSchedules.update',
      'subscriptions.update',
      'customers.update',
    ])
    expect(writes()[0]!.args).toEqual([
      'sub_sched_1',
      { default_settings: { default_payment_method: 'pm_new' } },
    ])
  })

  test('502 when Stripe fails partway, and a retry with the same intent completes', async () => {
    memberWithSub()
    setupIntents = {
      seti_ok: {
        customer: 'cus_me',
        status: 'succeeded',
        payment_method: { id: 'pm_new', card: VISA },
      },
    }
    const cookie = await sessionCookie('member@example.com')

    failSubscriptionUpdate = true
    const failed = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_ok' } })
    expect(failed.statusCode).toBe(502)
    expect((failed.__json() as { error: string }).error).toContain('Your card was saved')

    failSubscriptionUpdate = false
    stripeCalls.length = 0
    const retried = await post(UPDATE_PATH, { cookie, body: { setup_intent_id: 'seti_ok' } })
    expect(retried.statusCode).toBe(200)
    expect(writes().map((c) => c.method)).toEqual(['subscriptions.update', 'customers.update'])
  })

  test('only the session email is consulted — never a client-supplied one', async () => {
    existingCustomers = [
      { id: 'cus_other', email: 'other@example.com' },
      { id: 'cus_me', email: 'member@example.com' },
    ]
    subsByCustomer = { cus_other: [{ id: 'sub_other' }] }
    setupIntents = {
      seti_other: {
        customer: 'cus_other',
        status: 'succeeded',
        payment_method: { id: 'pm_new', card: VISA },
      },
    }
    const cookie = await sessionCookie('member@example.com')
    const res = await post(UPDATE_PATH, {
      cookie,
      body: { setup_intent_id: 'seti_other', email: 'other@example.com' },
    })
    // member@ has no subscription of their own, so there is nothing to update.
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })
})
