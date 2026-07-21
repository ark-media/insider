// Unit tests for POST /api/stripe/create-checkout-session.
//
// Strategy mirrors gift.test.ts: mock.module('stripe', …) swaps the SDK for
// a fake whose customers/subscriptions/prices/checkout methods record args
// and return canned responses. We assert: input validation, the rate
// limiter, find-or-create behavior, and that the Session is created with
// `customer: customer.id`.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createDevApiHarness,
  makeFakeReq,
  silenceExpectedConsole,
  type MakeReqOpts,
  type Middleware,
} from './test-utils'
import { SUPPORTED_CURRENCIES } from './lib/pricing'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []

// Per-test config:
//   existingCustomers   → what customers.list({ email }) returns
//   subsByCustomer      → what subscriptions.list({ customer }) returns
//   nextSessionId       → id stamped onto the returned Session
let existingCustomers: Array<{ id: string; email: string }> = []
let subsByCustomer: Record<string, Array<{ id: string; status?: string }>> = {}
let nextSessionId = 'cs_test_1'

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return {
        data: existingCustomers.filter((c) => c.email === args.email),
      }
    },
    create: async (args: { email: string; name?: string }) => {
      stripeCalls.push({ method: 'customers.create', args: [args] })
      return { id: 'cus_new', email: args.email, name: args.name }
    },
  }
  subscriptions = {
    list: async (args: { customer: string; status?: string; limit?: number }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      return { data: subsByCustomer[args.customer] ?? [] }
    },
    create: async () => ({}),
    update: async () => ({}),
    retrieve: async () => ({}),
  }
  prices = {
    // resolveCatalogPrice resolves the price by lookup_key, reading unit_amount
    // (the USD floor) plus currency_options for the other supported currencies
    // and the product id (for PWYC inline price_data). 800¢ monthly, 8000¢
    // yearly — same-numeral floors across currencies, matching the catalog.
    list: async (args: { lookup_keys?: string[] }) => {
      stripeCalls.push({ method: 'prices.list', args: [args] })
      const key = args.lookup_keys?.[0] ?? ''
      const base = key.includes('monthly') ? 800 : 8000
      // Provide currency_options for every supported currency but usd (the base)
      // so resolveCatalogPrice, which loops SUPPORTED_CURRENCIES and throws on a
      // gap, resolves cleanly regardless of how long that list grows.
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const cur of SUPPORTED_CURRENCIES) {
        if (cur !== 'usd') currency_options[cur] = { unit_amount: base }
      }
      return {
        data: [
          {
            id: `price_${key}`,
            product: `prod_${key.replace(/_(monthly|yearly)$/, '')}`,
            unit_amount: base,
            currency: 'usd',
            currency_options,
          },
        ],
      }
    },
    create: async (args: unknown) => {
      stripeCalls.push({ method: 'prices.create', args: [args] })
      return { id: 'price_dyn_1' }
    },
  }
  checkout = {
    sessions: {
      create: async (args: Record<string, unknown>) => {
        stripeCalls.push({ method: 'checkout.sessions.create', args: [args] })
        return {
          id: nextSessionId,
          client_secret: `${nextSessionId}_secret_ABC`,
        }
      },
      retrieve: async () => ({}),
    },
  }
  coupons = {
    // Empty by default: existing promo tests live elsewhere and this route's
    // contract isn't promo-dependent.
    list: async () => ({ data: [], has_more: false }),
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
  paymentIntents = {
    create: async () => ({}),
    retrieve: async () => ({}),
    update: async () => ({}),
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
// The catalog price is resolved by lookup_key (no STRIPE_PRICE_* env vars — task
// 8 removed them); the exact-floor path uses that price, a PWYC uplift uses
// inline price_data.
const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

function getHandler(path: string): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(path)
}

// ---------------------------------------------------------------------------
// Fake req/res
// ---------------------------------------------------------------------------
const makeReq = (o: MakeReqOpts = {}) =>
  makeFakeReq({ method: 'POST', url: PATH, ...o })

type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __header: (name: string) => string | undefined
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {}
  let body = ''
  let statusCode = 200
  let ended = false
  return {
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
    __header: (name: string) => headers[name.toLowerCase()],
  } as unknown as FakeRes
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
// Global fetch mock (entitlement/SC reads it but they shouldn't fire here).
// Captures so we can fail the test if anything unexpected hits the network.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string }> = []
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  return new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  stripeCalls.length = 0
  fetchCalls.length = 0
  existingCustomers = []
  subsByCustomer = {}
  nextSessionId = 'cs_test_1'
})

// ---------------------------------------------------------------------------
const PATH = '/api/stripe/create-checkout-session'

// Each call to getHandler() returns a fresh middleware (new plugin instance
// → new rate limiter → new price cache). Tests that rely on rate-limiter
// state across calls should pin a single handler via getSharedHandler() and
// pass it to postWith().
async function post(body: unknown): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(getHandler(PATH), makeReq({ body }), res)
  return res
}

async function postWith(handler: Middleware, body: unknown): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(handler, makeReq({ body }), res)
  return res
}

function lastSessionCreateArgs(): Record<string, unknown> {
  const call = [...stripeCalls].reverse().find(
    (c) => c.method === 'checkout.sessions.create',
  )
  if (!call) throw new Error('no checkout.sessions.create call recorded')
  return call.args[0] as Record<string, unknown>
}

// ===========================================================================
describe('POST /api/stripe/create-checkout-session — input validation', () => {
  test('400 when email missing', async () => {
    const res = await post({ plan: 'monthly' })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'Email is required.' })
  })

  test('400 when email is malformed', async () => {
    const res = await post({ email: '   foo', plan: 'monthly' })
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'Please enter a valid email.' })
  })

  test('400 when plan is missing or invalid', async () => {
    const res = await post({ email: 'a@b.co' })
    expect(res.statusCode).toBe(400)
  })

  test('400 when name exceeds the length cap', async () => {
    const res = await post({
      email: 'a@b.co',
      name: 'x'.repeat(300),
      plan: 'monthly',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/stripe/create-checkout-session — find-or-create', () => {
  test('no matching customer → creates one', async () => {
    const res = await post({ email: 'new@example.com', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    const created = stripeCalls.find((c) => c.method === 'customers.create')
    expect(created).toBeTruthy()
    const session = lastSessionCreateArgs()
    expect(session.customer).toBe('cus_new')
  })

  test('single existing customer → reused, no create call', async () => {
    existingCustomers = [{ id: 'cus_existing', email: 'a@b.co' }]
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.find((c) => c.method === 'customers.create')).toBeUndefined()
    expect(lastSessionCreateArgs().customer).toBe('cus_existing')
  })

  test('multiple customers → picks one without an active subscription', async () => {
    existingCustomers = [
      { id: 'cus_with_sub', email: 'a@b.co' },
      { id: 'cus_clean', email: 'a@b.co' },
    ]
    subsByCustomer = { cus_with_sub: [{ id: 'sub_1' }] }
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_clean')
  })

  test('multiple customers all with active subs → falls back to the first', async () => {
    existingCustomers = [
      { id: 'cus_a', email: 'a@b.co' },
      { id: 'cus_b', email: 'a@b.co' },
    ]
    subsByCustomer = {
      cus_a: [{ id: 'sub_a' }],
      cus_b: [{ id: 'sub_b' }],
    }
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_a')
  })
})

describe('POST /api/stripe/create-checkout-session — session shape', () => {
  test('attaches customer.id to the Session and returns the client_secret', async () => {
    const res = await post({ email: 'a@b.co', name: 'A B', plan: 'yearly' })
    expect(res.statusCode).toBe(200)
    const json = res.__json() as Record<string, unknown>
    expect(json.client_secret).toBe('cs_test_1_secret_ABC')
    expect(json.checkout_session_id).toBe('cs_test_1')
    expect(json.plan).toBe('yearly')
    const args = lastSessionCreateArgs()
    expect(args.customer).toBe('cus_new')
    expect(args.mode).toBe('subscription')
  })

  test('enables Stripe Tax and lets Checkout persist the billing address', async () => {
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    const args = lastSessionCreateArgs()
    // automatic_tax on the session also turns on tax for the subscription
    // Checkout creates — we never call subscriptions.create ourselves.
    expect(args.automatic_tax).toEqual({ enabled: true })
    // Required so the address entered via BillingAddressElement saves back to
    // the pre-set Customer (and feeds the tax jurisdiction).
    expect(args.customer_update).toEqual({ address: 'auto' })
  })

  test('exact-floor amount uses the catalog price (no inline price_data)', async () => {
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    const args = lastSessionCreateArgs()
    const lineItems = args.line_items as Array<Record<string, unknown>>
    expect(lineItems[0].price).toBe('price_ark_plus_monthly')
    expect(lineItems[0].price_data).toBeUndefined()
  })

  test('PWYC uplift uses inline price_data on the catalog product, exclusive tax', async () => {
    // A custom amount above the floor uses inline price_data (not product_data,
    // which would mint a new Product) on the persistent catalog product. It must
    // carry tax_behavior or Stripe rejects it under automatic tax.
    const res = await post({
      email: 'a@b.co',
      plan: 'monthly',
      custom_amount_cents: 1500,
    })
    expect(res.statusCode).toBe(200)
    // No standalone Price object is created — the amount rides inline.
    expect(stripeCalls.find((c) => c.method === 'prices.create')).toBeUndefined()
    const args = lastSessionCreateArgs()
    const lineItems = args.line_items as Array<Record<string, unknown>>
    const priceData = lineItems[0].price_data as Record<string, unknown>
    expect(priceData.unit_amount).toBe(1500)
    expect(priceData.product).toBe('prod_ark_plus')
    expect(priceData.currency).toBe('usd')
    expect(priceData.tax_behavior).toBe('exclusive')
  })

  test('does not enable Adaptive Pricing (currency_options is incompatible)', async () => {
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().adaptive_pricing).toBeUndefined()
  })

  test('custom amount below the floor is rejected', async () => {
    const res = await post({
      email: 'a@b.co',
      plan: 'monthly',
      custom_amount_cents: 500, // floor is 800
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/stripe/create-checkout-session — tier + currency', () => {
  test('tier defaults to ark-plus and resolves its lookup_key', async () => {
    const res = await post({ email: 'a@b.co', plan: 'yearly' })
    expect(res.statusCode).toBe(200)
    expect((res.__json() as Record<string, unknown>).tier).toBe('ark-plus')
    const lineItems = lastSessionCreateArgs().line_items as Array<Record<string, unknown>>
    expect(lineItems[0].price).toBe('price_ark_plus_yearly')
  })

  test('tier=bundle resolves the bundle price', async () => {
    const res = await post({ email: 'bundle@b.co', plan: 'yearly', tier: 'bundle' })
    expect(res.statusCode).toBe(200)
    const lineItems = lastSessionCreateArgs().line_items as Array<Record<string, unknown>>
    expect(lineItems[0].price).toBe('price_bundle_yearly')
  })

  test('an unknown tier falls back to ark-plus', async () => {
    const res = await post({ email: 'x@b.co', plan: 'yearly', tier: 'platinum' })
    expect(res.statusCode).toBe(200)
    expect((res.__json() as Record<string, unknown>).tier).toBe('ark-plus')
  })

  test('supported currency is passed to the session; PWYC validates its floor', async () => {
    const res = await post({
      email: 'gb@b.co',
      plan: 'monthly',
      currency: 'gbp',
      custom_amount_cents: 900,
    })
    expect(res.statusCode).toBe(200)
    const args = lastSessionCreateArgs()
    expect(args.currency).toBe('gbp')
    const priceData = (args.line_items as Array<Record<string, unknown>>)[0]
      .price_data as Record<string, unknown>
    expect(priceData.currency).toBe('gbp')
    expect(priceData.unit_amount).toBe(900)
  })

  test('unsupported currency falls back to USD', async () => {
    // kwd (Kuwaiti dinar) is deliberately outside SUPPORTED_CURRENCIES — Kuwait
    // prices in USD in the localized table.
    const res = await post({ email: 'jp@b.co', plan: 'monthly', currency: 'kwd' })
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().currency).toBe('usd')
    expect((res.__json() as Record<string, unknown>).currency).toBe('usd')
  })
})

describe('POST /api/stripe/create-checkout-session — single-active-subscription guard', () => {
  test('409 when the email already holds a live subscription', async () => {
    existingCustomers = [{ id: 'cus_live', email: 'member@b.co' }]
    subsByCustomer = { cus_live: [{ id: 'sub_live', status: 'active' }] }
    const res = await post({ email: 'member@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as Record<string, unknown>).code).toBe('already_subscribed')
    // Never reached session creation.
    expect(stripeCalls.find((c) => c.method === 'checkout.sessions.create')).toBeUndefined()
  })

  test('a canceled/incomplete sub does not block a new checkout', async () => {
    existingCustomers = [{ id: 'cus_old', email: 'churned@b.co' }]
    subsByCustomer = { cus_old: [{ id: 'sub_old', status: 'canceled' }] }
    const res = await post({ email: 'churned@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/stripe/create-checkout-session — rate limit', () => {
  test('returns 429 after the 6th attempt with the same email', async () => {
    // Pin one handler so the rate-limiter bucket survives across calls.
    const handler = getHandler(PATH)
    const body = { email: 'spammer@example.com', plan: 'monthly' as const }
    // Capacity: 5 — first five should succeed, sixth should 429.
    for (let i = 0; i < 5; i += 1) {
      const ok = await postWith(handler, body)
      expect(ok.statusCode).toBe(200)
    }
    const blocked = await postWith(handler, body)
    expect(blocked.statusCode).toBe(429)
    expect(blocked.__header('retry-after')).toBeTruthy()
  })
})
