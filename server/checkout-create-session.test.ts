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
let existingCustomers: Array<{ id: string; email: string; currency?: string }> = []
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

// --- neon + Auth0 mocks (existing-account guard) ------------------------------
// Only the DB_ENV tests reach these: without DATABASE_URL the guard is off. The
// membership table holds no email, so the guard goes email → Auth0 user ids →
// rows; `auth0SubsByEmail` stages the first hop (null = the lookup throws) and
// `membershipRowsBySub` the second.
let auth0SubsByEmail = new Map<string, string[] | null>()
let membershipRowsBySub: Record<string, Record<string, unknown>> = {}
let membershipQueryFails = false
const sqlTexts: string[] = []

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      sqlTexts.push(text)
      if (text.includes('from membership where auth0_sub = any')) {
        if (membershipQueryFails) return Promise.reject(new Error('neon down'))
        const subs = values[0] as string[]
        return Promise.resolve(subs.map((sub) => membershipRowsBySub[sub]).filter(Boolean))
      }
      return Promise.resolve([])
    }) as unknown,
  __esModule: true,
}))

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

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'
import { signSessionToken, signCheckoutToken } from './lib/session'
import { CHECKOUT_COOKIE_NAME, SESSION_COOKIE_NAME } from './lib/cookies'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
// The catalog price is resolved by lookup_key (no STRIPE_PRICE_* env vars — task
// 8 removed them); the exact-floor path uses that price, a PWYC uplift uses
// inline price_data.
const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  // Signs the post-payment checkout token, which two tests mint to prove it
  // does NOT count as a login here.
  CHECKOUT_SESSION_SECRET: 'checkout-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

// The production shape: a database (so the existing-account guard is live) and
// an Auth0 Management client (the email → sub hop).
const DB_ENV = {
  ...BASE_ENV,
  DATABASE_URL: 'postgres://stub-checkout-test',
  // Unique per file: getManagementClient caches its client per domain+client id
  // for the whole process, and `bun test` shares one process — a shared id would
  // hand this file another suite's mocked client (and its staged lookups).
  AUTH0_MANAGEMENT_CLIENT_ID: 'cid-checkout-create-session',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'csec',
  AUTH0_TENANT_DOMAIN: 'https://tenant.us.auth0.com',
}

function getHandler(path: string, env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(path)
}

// A durable login (the ark_session cookie) as this address.
async function sessionCookie(email: string): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await signSessionToken({ email, roles: [] }, BASE_ENV)}`
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
  auth0SubsByEmail = new Map()
  membershipRowsBySub = {}
  membershipQueryFails = false
  sqlTexts.length = 0
})

// ---------------------------------------------------------------------------
const PATH = '/api/stripe/create-checkout-session'

// Each call to getHandler() returns a fresh middleware (new plugin instance
// → new rate limiter → new price cache). Tests that rely on rate-limiter
// state across calls should pin a single handler via getSharedHandler() and
// pass it to postWith().
async function post(
  body: unknown,
  opts: { cookie?: string; env?: Record<string, string> } = {},
): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(
    getHandler(PATH, opts.env),
    makeReq({ body, ...(opts.cookie ? { cookie: opts.cookie } : {}) }),
    res,
  )
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

  // Reuse is for a PROVEN email only. An existing Customer carries a saved card,
  // a balance (a credited gift lands there) and a billing history; the email on
  // this form is just something somebody typed.
  test('unauthenticated + an existing customer → a FRESH customer, never the existing one', async () => {
    existingCustomers = [{ id: 'cus_existing', email: 'a@b.co' }]
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.find((c) => c.method === 'customers.create')).toBeTruthy()
    expect(lastSessionCreateArgs().customer).toBe('cus_new')
  })

  test('the checkout token is not proof of the email — still a fresh customer', async () => {
    // It is minted off an address typed into this same form.
    existingCustomers = [{ id: 'cus_existing', email: 'a@b.co' }]
    const token = await signCheckoutToken('a@b.co', BASE_ENV, null)
    const res = await post(
      { email: 'a@b.co', plan: 'monthly' },
      { cookie: `${CHECKOUT_COOKIE_NAME}=${token}` },
    )
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_new')
  })

  test('signed in as a DIFFERENT email → a fresh customer', async () => {
    existingCustomers = [{ id: 'cus_existing', email: 'a@b.co' }]
    const res = await post(
      { email: 'a@b.co', plan: 'monthly' },
      { cookie: await sessionCookie('someone-else@b.co') },
    )
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_new')
  })

  test('signed in as that email → single existing customer reused, no create call', async () => {
    existingCustomers = [{ id: 'cus_existing', email: 'a@b.co' }]
    const res = await post(
      { email: 'a@b.co', plan: 'monthly' },
      { cookie: await sessionCookie('a@b.co') },
    )
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.find((c) => c.method === 'customers.create')).toBeUndefined()
    expect(lastSessionCreateArgs().customer).toBe('cus_existing')
  })

  test('the session email matches case-insensitively', async () => {
    // Auth0 can hold a social identity's address with its capitals; checkout
    // lowercases what the buyer types. Same person.
    existingCustomers = [{ id: 'cus_existing', email: 'a@b.co' }]
    const res = await post(
      { email: 'A@B.co', plan: 'monthly' },
      { cookie: await sessionCookie('A@b.CO') },
    )
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_existing')
  })

  test('a new customer is created with the lowercased email', async () => {
    const res = await post({ email: '  New@Example.COM ', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    const created = stripeCalls.find((c) => c.method === 'customers.create')
    expect((created!.args[0] as { email: string }).email).toBe('new@example.com')
  })

  test('signed in, multiple customers → picks one without an active subscription', async () => {
    existingCustomers = [
      { id: 'cus_with_sub', email: 'a@b.co' },
      { id: 'cus_clean', email: 'a@b.co' },
    ]
    // Canceled, so the single-active-subscription guard lets the request through
    // and the pick is what is under test. (The fake ignores the status filter.)
    subsByCustomer = { cus_with_sub: [{ id: 'sub_1', status: 'canceled' }] }
    const res = await post(
      { email: 'a@b.co', plan: 'monthly' },
      { cookie: await sessionCookie('a@b.co') },
    )
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_clean')
  })

  test('signed in, multiple customers all with subs → falls back to the first', async () => {
    existingCustomers = [
      { id: 'cus_a', email: 'a@b.co' },
      { id: 'cus_b', email: 'a@b.co' },
    ]
    subsByCustomer = {
      cus_a: [{ id: 'sub_a', status: 'canceled' }],
      cus_b: [{ id: 'sub_b', status: 'canceled' }],
    }
    const res = await post(
      { email: 'a@b.co', plan: 'monthly' },
      { cookie: await sessionCookie('a@b.co') },
    )
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_a')
  })
})

// The HIGH finding. The webhook upserts the membership row `on conflict
// (auth0_sub)`, so a purchase made under a comped staffer's, an early-access
// member's or a gift recipient's address overwrote THEIR row — and the eventual
// subscription.deleted removed it. An address that already has a row must sign
// in first.
describe('POST /api/stripe/create-checkout-session — existing-account guard', () => {
  const COMP_ROW = {
    auth0_sub: 'auth0|staff',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    tier: 'bundle',
    status: 'active',
  }

  test('409 login_required when the typed email already has a membership row', async () => {
    auth0SubsByEmail.set('staff@ark.co', ['auth0|staff'])
    membershipRowsBySub = { 'auth0|staff': COMP_ROW }
    const res = await post({ email: 'Staff@ark.co', plan: 'monthly' }, { env: DB_ENV })
    expect(res.statusCode).toBe(409)
    expect(res.__json()).toEqual({
      code: 'login_required',
      error: 'You already have an Ark account. Sign in to change or add to your plan.',
    })
    // Nothing was created in Stripe on the strength of a typed address.
    expect(stripeCalls.find((c) => c.method === 'customers.create')).toBeUndefined()
    expect(stripeCalls.find((c) => c.method === 'checkout.sessions.create')).toBeUndefined()
  })

  test('the checkout token does not lift the guard', async () => {
    auth0SubsByEmail.set('staff@ark.co', ['auth0|staff'])
    membershipRowsBySub = { 'auth0|staff': COMP_ROW }
    const token = await signCheckoutToken('staff@ark.co', BASE_ENV, 'auth0|staff')
    const res = await post(
      { email: 'staff@ark.co', plan: 'monthly' },
      { env: DB_ENV, cookie: `${CHECKOUT_COOKIE_NAME}=${token}` },
    )
    expect(res.statusCode).toBe(409)
    expect((res.__json() as Record<string, unknown>).code).toBe('login_required')
  })

  test('signed in as that email → allowed through', async () => {
    auth0SubsByEmail.set('staff@ark.co', ['auth0|staff'])
    membershipRowsBySub = { 'auth0|staff': COMP_ROW }
    const res = await post(
      { email: 'staff@ark.co', plan: 'monthly' },
      { env: DB_ENV, cookie: await sessionCookie('Staff@ark.co') },
    )
    expect(res.statusCode).toBe(200)
  })

  test('signed in as someone else → still refused', async () => {
    auth0SubsByEmail.set('staff@ark.co', ['auth0|staff'])
    membershipRowsBySub = { 'auth0|staff': COMP_ROW }
    const res = await post(
      { email: 'staff@ark.co', plan: 'monthly' },
      { env: DB_ENV, cookie: await sessionCookie('attacker@evil.co') },
    )
    expect(res.statusCode).toBe(409)
  })

  test('an email with an Auth0 account but no membership row buys normally', async () => {
    // A free reader, or a lapsed member whose row was removed at cancel.
    auth0SubsByEmail.set('reader@b.co', ['auth0|reader'])
    const res = await post({ email: 'reader@b.co', plan: 'monthly' }, { env: DB_ENV })
    expect(res.statusCode).toBe(200)
  })

  test('fails CLOSED when the Auth0 lookup errors — no session is sold', async () => {
    auth0SubsByEmail.set('staff@ark.co', null)
    const res = await post({ email: 'staff@ark.co', plan: 'monthly' }, { env: DB_ENV })
    expect(res.statusCode).toBe(502)
    expect(stripeCalls.find((c) => c.method === 'checkout.sessions.create')).toBeUndefined()
  })

  test('fails CLOSED when the membership read errors', async () => {
    auth0SubsByEmail.set('staff@ark.co', ['auth0|staff'])
    membershipQueryFails = true
    const res = await post({ email: 'staff@ark.co', plan: 'monthly' }, { env: DB_ENV })
    expect(res.statusCode).toBe(502)
  })

  test('the already_subscribed guard still answers first for a live subscriber', async () => {
    existingCustomers = [{ id: 'cus_live', email: 'member@b.co' }]
    subsByCustomer = { cus_live: [{ id: 'sub_live', status: 'active' }] }
    auth0SubsByEmail.set('member@b.co', ['auth0|member'])
    membershipRowsBySub = { 'auth0|member': { ...COMP_ROW, auth0_sub: 'auth0|member' } }
    const res = await post({ email: 'member@b.co', plan: 'monthly' }, { env: DB_ENV })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as Record<string, unknown>).code).toBe('already_subscribed')
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
    // Required so what the buyer enters via BillingAddressElement saves back to
    // the pre-set Customer: the address feeds the tax jurisdiction, and `name`
    // is the only capture point for a new subscriber's name (it defaults to
    // 'never', which is what left customer.name null).
    expect(args.customer_update).toEqual({ address: 'auto', name: 'auto' })
  })

  test('does not ask Stripe to collect consent — the checkboxes are ours', async () => {
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    const args = lastSessionCreateArgs()
    // consent_collection can only ever collect Stripe's own single statement,
    // via the beta-gated TermsElement. Counsel wants two, one of them naming
    // the recurring charge, so the boxes moved into our payment form and the
    // acceptance is recorded by POST /api/stripe/record-consent. Leaving this
    // set would block confirm forever: nothing renders to satisfy it.
    expect(args.consent_collection).toBeUndefined()
  })

  test('takes promotion codes instead of a server-set discount', async () => {
    const res = await post({ email: 'a@b.co', plan: 'monthly' })
    expect(res.statusCode).toBe(200)
    const args = lastSessionCreateArgs()
    // The buyer needs a field to type a code into, and Stripe refuses
    // allow_promotion_codes alongside a `discounts` array on one Session ("You
    // may only specify one of these parameters"). So every discount — the house
    // sale included — is applied in the browser by code, and this route never
    // picks a coupon.
    expect(args.allow_promotion_codes).toBe(true)
    expect(args.discounts).toBeUndefined()
    expect(stripeCalls.some((c) => c.method === 'coupons.list')).toBe(false)
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

// A subscription keeps one currency for life and a Customer's balance only pays
// invoices in its own, so a returning member's checkout is held to the currency
// their reused Customer already bills in.
describe('POST /api/stripe/create-checkout-session — currency lock', () => {
  test('signed in, account bills in CAD, asks for USD → 409 currency_locked, nothing created', async () => {
    existingCustomers = [{ id: 'cus_cad', email: 'a@b.co', currency: 'cad' }]
    const res = await post(
      { email: 'a@b.co', plan: 'monthly', currency: 'usd' },
      { cookie: await sessionCookie('a@b.co') },
    )
    expect(res.statusCode).toBe(409)
    expect(res.__json()).toMatchObject({ code: 'currency_locked', currency: 'cad' })
    expect(stripeCalls.find((c) => c.method === 'customers.create')).toBeUndefined()
    expect(stripeCalls.find((c) => c.method === 'checkout.sessions.create')).toBeUndefined()
  })

  test('signed in, asks for the account currency → reuses the Customer in it', async () => {
    existingCustomers = [{ id: 'cus_cad', email: 'a@b.co', currency: 'cad' }]
    const res = await post(
      { email: 'a@b.co', plan: 'monthly', currency: 'cad' },
      { cookie: await sessionCookie('a@b.co') },
    )
    expect(res.statusCode).toBe(200)
    const args = lastSessionCreateArgs()
    expect(args.customer).toBe('cus_cad')
    expect(args.currency).toBe('cad')
  })

  test('unauthenticated → no lock: a fresh Customer in the chosen currency', async () => {
    existingCustomers = [{ id: 'cus_cad', email: 'a@b.co', currency: 'cad' }]
    const res = await post({ email: 'a@b.co', plan: 'monthly', currency: 'usd' })
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_new')
    expect(lastSessionCreateArgs().currency).toBe('usd')
  })

  test('a never-billed Customer is reused in any currency', async () => {
    existingCustomers = [{ id: 'cus_fresh', email: 'a@b.co' }]
    const res = await post(
      { email: 'a@b.co', plan: 'monthly', currency: 'eur' },
      { cookie: await sessionCookie('a@b.co') },
    )
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_fresh')
    expect(lastSessionCreateArgs().currency).toBe('eur')
  })

  test('a Customer in a currency we do not sell → a fresh Customer, not a lock', async () => {
    existingCustomers = [{ id: 'cus_kwd', email: 'a@b.co', currency: 'kwd' }]
    const res = await post(
      { email: 'a@b.co', plan: 'monthly', currency: 'usd' },
      { cookie: await sessionCookie('a@b.co') },
    )
    expect(res.statusCode).toBe(200)
    expect(lastSessionCreateArgs().customer).toBe('cus_new')
  })
})

describe('GET /api/stripe/billing-currency', () => {
  const BC_PATH = '/api/stripe/billing-currency'
  async function get(cookie?: string): Promise<FakeRes> {
    const res = makeRes()
    await runHandler(
      getHandler(BC_PATH),
      makeFakeReq({ method: 'GET', url: BC_PATH, ...(cookie ? { cookie } : {}) }),
      res,
    )
    return res
  }

  test('signed out → null, without asking Stripe', async () => {
    existingCustomers = [{ id: 'cus_cad', email: 'a@b.co', currency: 'cad' }]
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ currency: null })
    expect(stripeCalls).toEqual([])
  })

  test('signed in → the currency their Customer bills in', async () => {
    existingCustomers = [{ id: 'cus_cad', email: 'a@b.co', currency: 'cad' }]
    const res = await get(await sessionCookie('a@b.co'))
    expect(res.__json()).toEqual({ currency: 'cad' })
  })

  test('the checkout token is not a login → null', async () => {
    existingCustomers = [{ id: 'cus_cad', email: 'a@b.co', currency: 'cad' }]
    const token = await signCheckoutToken('a@b.co', BASE_ENV, null)
    const res = await get(`${CHECKOUT_COOKIE_NAME}=${token}`)
    expect(res.__json()).toEqual({ currency: null })
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
