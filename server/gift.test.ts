// Unit tests for the gift endpoints + webhook activation.
//
// Strategy: `mock.module('stripe', …)` swaps the Stripe SDK for a fake class
// whose methods record calls and return canned responses. SC calls are
// intercepted via `globalThis.fetch` (same pattern as dev-api.test.ts).

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createDevApiHarness,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
type StripeCall = { method: string; args: unknown[] }

const stripeCalls: StripeCall[] = []

type FakePI = {
  id: string
  client_secret: string
  status: 'succeeded' | 'processing' | 'requires_action'
  metadata: Record<string, string>
}

type FakeSession = {
  id: string
  client_secret: string
  status?: string
  metadata: Record<string, string>
  payment_intent: FakePI | string | null
}

let existingCustomer: { id: string; email: string } | null = null
let nextPIStatus: FakePI['status'] = 'succeeded'
let retrievedPI: FakePI | null = null
let retrievedSession: FakeSession | null = null
let webhookEvent: unknown = null

// Coupons returned by stripe.coupons.list. The gift route no longer reads them
// (discounts arrive by code); the stub stays so a regression that reaches for
// the catalog shows up as a recorded call.
let availableCoupons: Array<Record<string, unknown>> = []

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      const match =
        existingCustomer && existingCustomer.email === args.email
          ? existingCustomer
          : null
      return { data: match ? [match] : [] }
    },
    create: async (args: { email: string; name?: string }) => {
      stripeCalls.push({ method: 'customers.create', args: [args] })
      return { id: 'cus_new', email: args.email, name: args.name }
    },
  }
  paymentIntents = {
    create: async (args: {
      amount: number
      currency: string
      customer: string
      metadata: Record<string, string>
    }) => {
      stripeCalls.push({ method: 'paymentIntents.create', args: [args] })
      return {
        id: 'pi_test_1',
        client_secret: 'pi_test_1_secret_ABC',
        status: nextPIStatus,
        metadata: args.metadata,
      } satisfies FakePI
    },
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'paymentIntents.retrieve', args: [id] })
      if (!retrievedPI) throw new Error('retrievedPI not configured for this test')
      return retrievedPI
    },
    update: async (id: string, args: { metadata: Record<string, string> }) => {
      stripeCalls.push({ method: 'paymentIntents.update', args: [id, args] })
      return { id, metadata: args.metadata }
    },
  }
  checkout = {
    sessions: {
      create: async (args: Record<string, unknown>) => {
        stripeCalls.push({ method: 'checkout.sessions.create', args: [args] })
        return {
          id: 'cs_test_1',
          client_secret: 'cs_test_1_secret_ABC',
        }
      },
      retrieve: async (id: string, opts?: unknown) => {
        stripeCalls.push({ method: 'checkout.sessions.retrieve', args: [id, opts] })
        if (!retrievedSession)
          throw new Error('retrievedSession not configured for this test')
        return retrievedSession
      },
    },
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
  coupons = {
    list: async (args: { limit: number; starting_after?: string }) => {
      stripeCalls.push({ method: 'coupons.list', args: [args] })
      return { data: availableCoupons, has_more: false }
    },
  }
  prices = {
    // The gift checkout resolves the one-time gift Price by lookup_key. Return a
    // canned price whose USD unit_amount matches the term ($48 6mo / $80 1yr) and
    // carries currency_options for EVERY supported currency (resolveGiftPrice
    // throws on a missing one).
    list: async (args: { lookup_keys?: string[] }) => {
      stripeCalls.push({ method: 'prices.list', args: [args] })
      const key = args.lookup_keys?.[0] ?? ''
      const unit = key.endsWith('_6mo') ? 4800 : 8000
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const c of SUPPORTED_CURRENCIES) currency_options[c] = { unit_amount: unit }
      return {
        data: [{ id: `price_${key}`, product: 'prod_gift', unit_amount: unit, currency_options }],
      }
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static import AFTER mock.module so the plugin picks up the fake Stripe.
import { devApiPlugin } from './dev-api'
import { giftTokenForPaymentIntent } from './routes/stripe/webhook'
import { signGiftClaimToken, verifyGiftClaimToken } from './lib/session'
import { SUPPORTED_CURRENCIES } from './lib/pricing'

// ---------------------------------------------------------------------------
// Plugin harness
// ---------------------------------------------------------------------------
const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'wh_test',
}

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
  __header: (name: string) => string | undefined
}

function makeReq(opts: {
  method?: string
  url?: string
  body?: unknown
  rawBody?: Buffer
  headers?: Record<string, string>
}): IncomingMessage {
  const raw =
    opts.rawBody ??
    (opts.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(opts.body), 'utf8'))
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'POST'
  stream.url = opts.url ?? '/'
  stream.headers = opts.headers ?? {}
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {}
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
  return res
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
// SC fetch mock (same pattern as the SMS test file)
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

silenceExpectedConsole()

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  fetchCalls.length = 0
  stripeCalls.length = 0
  existingCustomer = null
  nextPIStatus = 'succeeded'
  retrievedPI = null
  retrievedSession = null
  webhookEvent = null
  availableCoupons = []
  fetchImpl = async () => new Response('{}', { status: 200 })
})

const CREATE_PATH = '/api/gift/create-checkout'
const STATUS_PATH = '/api/gift/status'
const CLAIM_PATH = '/api/gift/claim'
const WEBHOOK_PATH = '/api/stripe/webhook'

// ===========================================================================
// POST /api/gift/create-checkout
// ===========================================================================

describe('POST /api/gift/create-checkout — validation', () => {
  test('405 on GET', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({ method: 'GET' })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(405)
  })

  test('500 when STRIPE_SECRET_KEY is not set', async () => {
    // Build the plugin without STRIPE_SECRET_KEY so `stripe` is null.
    const h = getHandler(CREATE_PATH, { STRIPE_SECRET_KEY: '' })
    const req = makeReq({ body: { giver_email: 'g@x.com', recipient_email: 'r@x.com', term: '1yr' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(500)
    expect((res.__json() as { error: string }).error).toBe('not_configured')
  })

  test('400 when giver_email missing', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({ body: { recipient_email: 'r@x.com', term: '1yr' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/your email/i)
    expect(stripeCalls).toHaveLength(0)
  })

  test('400 when recipient_email missing', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({ body: { giver_email: 'g@x.com', term: '1yr' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/recipient/i)
    expect(stripeCalls).toHaveLength(0)
  })

  test('400 on missing term', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({ body: { giver_email: 'g@x.com', recipient_email: 'r@x.com' } })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/term/i)
  })

  test('400 on invalid term value', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({
      body: { giver_email: 'g@x.com', recipient_email: 'r@x.com', term: 'lifetime' },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
    expect(stripeCalls).toHaveLength(0)
  })

  test('400 when message exceeds 500 chars', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({
      body: {
        giver_email: 'g@x.com',
        recipient_email: 'r@x.com',
        term: '1yr',
        message: 'x'.repeat(501),
      },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/too long/i)
    expect(stripeCalls).toHaveLength(0)
  })
})

// Pulls the typed args off the recorded checkout.sessions.create call.
type SessionArgs = {
  mode: string
  ui_mode: string
  customer: string
  currency: string
  adaptive_pricing?: { enabled: boolean }
  automatic_tax: { enabled: boolean }
  consent_collection?: { terms_of_service: string }
  customer_update: { address: string }
  line_items: Array<{ quantity: number; price: string }>
  payment_intent_data: {
    receipt_email: string
    description: string
    metadata: Record<string, string>
  }
  metadata: Record<string, string>
}

function sessionCreateArgs(): SessionArgs {
  const call = stripeCalls.find((c) => c.method === 'checkout.sessions.create')
  expect(call).toBeDefined()
  return call!.args[0] as SessionArgs
}

describe('POST /api/gift/create-checkout — happy paths', () => {
  test('1yr: creates new Stripe customer + payment-mode Session with the $80 gift Price (USD), per-currency, and full PI metadata', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({
      body: {
        giver_email: 'giver@example.com',
        giver_name: 'Bob',
        recipient_email: 'recip@example.com',
        recipient_name: 'Alice',
        term: '1yr',
        message: 'Happy birthday',
      },
    })
    const res = makeRes()
    await runHandler(h, req, res)

    expect(res.statusCode).toBe(200)
    const body = res.__json() as {
      checkout_session_id: string
      client_secret: string
      term: string
    }
    expect(body.checkout_session_id).toBe('cs_test_1')
    expect(body.client_secret).toBe('cs_test_1_secret_ABC')
    expect(body.term).toBe('1yr')

    // Verify customer lookup + create
    const listCall = stripeCalls.find((c) => c.method === 'customers.list')
    expect(listCall).toBeDefined()
    expect((listCall!.args[0] as { email: string }).email).toBe('giver@example.com')

    const createCustomerCall = stripeCalls.find((c) => c.method === 'customers.create')
    expect(createCustomerCall).toBeDefined()

    // No bare PaymentIntent — gifts route through a Checkout Session.
    expect(stripeCalls.some((c) => c.method === 'paymentIntents.create')).toBe(false)

    // Verify Checkout Session create args
    const args = sessionCreateArgs()
    expect(args.mode).toBe('payment')
    expect(args.ui_mode).toBe('elements')
    expect(args.customer).toBe('cus_new')
    // Per-currency model replaced Adaptive Pricing: no adaptive_pricing flag; the
    // session's currency selects the gift Price's currency_options amount.
    expect(args.adaptive_pricing).toBeUndefined()
    expect(args.currency).toBe('usd')
    // Stripe Tax on the one-time gift session, with the address saved back to
    // the pre-set customer (feeds the tax jurisdiction).
    expect(args.automatic_tax).toEqual({ enabled: true })
    // No Stripe-collected consent: the gift form carries its own Terms
    // checkbox and records the acceptance via /api/stripe/record-consent.
    expect(args.consent_collection).toBeUndefined()
    expect(args.customer_update).toEqual({ address: 'auto' })
    expect(args.line_items[0].quantity).toBe(1)
    // The persistent one-time gift Price, resolved by lookup_key (default tier
    // Ark+, 1yr term → gift_ark_plus_1yr).
    expect(args.line_items[0].price).toBe('price_gift_ark_plus_1yr')

    // Gift metadata lives on the PaymentIntent (payment_intent_data) so the
    // existing payment_intent.succeeded webhook activates it unchanged.
    const pid = args.payment_intent_data
    expect(pid.receipt_email).toBe('giver@example.com')
    expect(pid.metadata.kind).toBe('gift')
    expect(pid.metadata.tier).toBe('ark-plus')
    expect(pid.metadata.term).toBe('1yr')
    expect(pid.metadata.currency).toBe('usd')
    expect(pid.metadata.giver_email).toBe('giver@example.com')
    expect(pid.metadata.giver_name).toBe('Bob')
    expect(pid.metadata.recipient_email).toBe('recip@example.com')
    expect(pid.metadata.recipient_name).toBe('Alice')
    expect(pid.metadata.message).toBe('Happy birthday')

    // Session-level metadata carries giver_email for the /status ownership check.
    expect(args.metadata.giver_email).toBe('giver@example.com')
  })

  test('6mo: resolves the $48 gift Price', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({
      body: {
        giver_email: 'g@x.com',
        recipient_email: 'r@x.com',
        term: '6mo',
      },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
    const args = sessionCreateArgs()
    expect(args.line_items[0].price).toBe('price_gift_ark_plus_6mo')
    expect(args.payment_intent_data.metadata.term).toBe('6mo')
  })

  test('tier param routes to the Bundle gift Price', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({
      body: {
        giver_email: 'g@x.com',
        recipient_email: 'r@x.com',
        tier: 'bundle',
        term: '1yr',
      },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
    const args = sessionCreateArgs()
    expect(args.line_items[0].price).toBe('price_gift_bundle_1yr')
    expect(args.payment_intent_data.metadata.tier).toBe('bundle')
  })

  test('reuses existing Stripe customer by email (no customers.create)', async () => {
    existingCustomer = { id: 'cus_existing', email: 'giver@example.com' }
    const h = getHandler(CREATE_PATH)
    const req = makeReq({
      body: {
        giver_email: 'giver@example.com',
        recipient_email: 'r@x.com',
        term: '1yr',
      },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'customers.create')).toBe(false)
    expect(sessionCreateArgs().customer).toBe('cus_existing')
  })

  test('normalizes emails to lowercase', async () => {
    const h = getHandler(CREATE_PATH)
    const req = makeReq({
      body: {
        giver_email: '  Giver@Example.COM ',
        recipient_email: 'Recip@Example.COM',
        term: '1yr',
      },
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
    const args = sessionCreateArgs()
    expect(args.payment_intent_data.metadata.giver_email).toBe('giver@example.com')
    expect(args.payment_intent_data.metadata.recipient_email).toBe('recip@example.com')
    expect(args.metadata.giver_email).toBe('giver@example.com')
  })
})

// ===========================================================================
// POST /api/gift/create-checkout — discounts
// ===========================================================================
// A discount reaches a gift Session by code, never as a server-set `discounts`
// array. The Session carries allow_promotion_codes so the giver has a field to
// type into, and Stripe refuses both parameters on one Session ("You may only
// specify one of these parameters"). The house sale is resolved by
// /api/promo/active and applied in the browser — which is why this route no
// longer reads the coupon catalog at all.

type SessionWithDiscounts = SessionArgs & {
  discounts?: Array<{ coupon: string }>
  allow_promotion_codes?: boolean
}

function couponLike(
  id: string,
  fields: {
    percent_off?: number | null
    amount_off?: number | null
    currency?: string | null
    metadata?: Record<string, string>
  },
): Record<string, unknown> {
  return {
    id,
    valid: true,
    name: null,
    percent_off: fields.percent_off ?? null,
    amount_off: fields.amount_off ?? null,
    currency: fields.currency ?? null,
    metadata: fields.metadata ?? {},
  }
}

async function postGift1yr(): Promise<FakeRes> {
  const h = getHandler(CREATE_PATH)
  const req = makeReq({
    body: { giver_email: 'g@x.com', recipient_email: 'r@x.com', term: '1yr' },
  })
  const res = makeRes()
  await runHandler(h, req, res)
  return res
}

describe('POST /api/gift/create-checkout — discounts', () => {
  test('the Session takes promotion codes, not a server-set discount', async () => {
    availableCoupons = [
      couponLike('coupon_pct20', { percent_off: 20, metadata: { auto_apply: 'true' } }),
    ]
    const res = await postGift1yr()
    expect(res.statusCode).toBe(200)
    const args = sessionCreateArgs() as SessionWithDiscounts
    expect(args.allow_promotion_codes).toBe(true)
    expect(args.discounts).toBeUndefined()
    // Source price is still the full $80 gift Price — Stripe discounts it.
    expect(args.line_items[0].price).toBe('price_gift_ark_plus_1yr')
  })

  test('never reads the coupon catalog — the browser applies the code', async () => {
    availableCoupons = [
      couponLike('coupon_pct20', { percent_off: 20, metadata: { auto_apply: 'true' } }),
    ]
    await postGift1yr()
    expect(stripeCalls.some((c) => c.method === 'coupons.list')).toBe(false)
  })
})

// ===========================================================================
// GET /api/gift/status
// ===========================================================================

function buildStatusSession(
  piMetadata: Record<string, string>,
  status: FakePI['status'] = 'succeeded',
): FakeSession {
  return {
    id: 'cs_1',
    client_secret: 's',
    status: 'complete',
    metadata: { giver_email: 'g@x.com', kind: 'gift' },
    payment_intent: { id: 'pi_1', client_secret: 's', status, metadata: piMetadata },
  }
}

describe('GET /api/gift/status', () => {
  test('400 when id is missing', async () => {
    const h = getHandler(STATUS_PATH)
    const req = makeReq({ method: 'GET', url: STATUS_PATH })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(400)
  })

  test('403 when giver_email param is missing', async () => {
    retrievedSession = buildStatusSession({ giver_email: 'g@x.com', kind: 'gift' })
    const h = getHandler(STATUS_PATH)
    const req = makeReq({ method: 'GET', url: `${STATUS_PATH}?id=cs_1` })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(403)
  })

  test('403 when email does not match Session giver', async () => {
    retrievedSession = buildStatusSession({ giver_email: 'g@x.com', kind: 'gift' })
    const h = getHandler(STATUS_PATH)
    const req = makeReq({
      method: 'GET',
      url: `${STATUS_PATH}?id=cs_1&email=attacker@x.com`,
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(403)
  })

  test('200 activated=false when gift_token not set', async () => {
    retrievedSession = buildStatusSession({ giver_email: 'g@x.com', kind: 'gift' })
    const h = getHandler(STATUS_PATH)
    const req = makeReq({
      method: 'GET',
      url: `${STATUS_PATH}?id=cs_1&email=g@x.com`,
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ status: 'succeeded', activated: false })
  })

  test('200 activated=true when gift_token is stamped on the PaymentIntent', async () => {
    retrievedSession = buildStatusSession({
      giver_email: 'g@x.com',
      kind: 'gift',
      gift_token: 'tok_abc',
    })
    const h = getHandler(STATUS_PATH)
    const req = makeReq({
      method: 'GET',
      url: `${STATUS_PATH}?id=cs_1&email=g@x.com`,
    })
    const res = makeRes()
    await runHandler(h, req, res)
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { activated: boolean }).activated).toBe(true)
  })
})

// ===========================================================================
// POST /api/stripe/webhook — gift activation
// ===========================================================================

function buildGiftPI(overrides: Partial<FakePI['metadata']> = {}): FakePI {
  return {
    id: 'pi_gift_1',
    client_secret: 'secret',
    status: 'succeeded',
    metadata: {
      kind: 'gift',
      term: '1yr',
      giver_email: 'giver@x.com',
      giver_name: 'Bob',
      recipient_email: 'recip@x.com',
      recipient_name: 'Alice',
      message: 'Enjoy',
      ...overrides,
    },
  }
}

async function runWebhook(envOverrides?: Record<string, string>): Promise<FakeRes> {
  const h = getHandler(WEBHOOK_PATH, envOverrides)
  const req = makeReq({
    method: 'POST',
    url: WEBHOOK_PATH,
    rawBody: Buffer.from('{}'),
    headers: { 'stripe-signature': 'sig_fake' },
  })
  const res = makeRes()
  await runHandler(h, req, res)
  return res
}

describe('Webhook — gift purchase (redemption model)', () => {
  // A gift now grants nothing at purchase (§3): the webhook writes a pending
  // gift row (skipped here — no DB) and emails the recipient a claim link, never
  // touching the feed provider. Redemption (POST /api/gift/redeem) writes the row.

  test('stamps the gift_token on the PI and emails a single magic link — no Beehiiv/Auth0 calls', async () => {
    const pi = buildGiftPI({ term: '1yr', giver_name: 'Bob', message: 'Enjoy' })
    webhookEvent = { type: 'payment_intent.succeeded', data: { object: pi } }
    retrievedPI = pi

    fetchImpl = async (url) => {
      if (url.startsWith('https://api.resend.com'))
        return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }

    const res = await runWebhook({ RESEND_API_KEY: 'rk_test' })
    expect(res.statusCode).toBe(200)

    // No provisioning at purchase time — not SC, and crucially not Auth0 (an
    // Auth0 account created here is what triggered the extra "verify email").
    expect(fetchCalls.some((c) => c.url.includes('/users'))).toBe(false)
    expect(fetchCalls.some((c) => c.url.endsWith('/subscriptions'))).toBe(false)
    expect(fetchCalls.some((c) => c.url.includes('/api/v2/'))).toBe(false)

    // gift_token stamped on the PI (idempotency + link source), kind preserved.
    const token = giftTokenForPaymentIntent('pi_gift_1', {
      SESSION_SECRET: BASE_ENV.SESSION_SECRET,
    })
    const update = stripeCalls.find((c) => c.method === 'paymentIntents.update')
    expect(update).toBeDefined()
    const md = (update!.args[1] as { metadata: Record<string, string> }).metadata
    expect(md.gift_token).toBe(token)
    expect(md.kind).toBe('gift')

    // Exactly one email, carrying the single /redeem?mt=… magic link.
    const emailCalls = fetchCalls.filter(
      (c) => c.method === 'POST' && c.url.startsWith('https://api.resend.com'),
    )
    expect(emailCalls.length).toBe(1)
    const body = emailCalls[0]!.body as { to: string; subject: string; html: string }
    expect(body.to).toBe('recip@x.com')
    expect(body.subject).toContain('Bob')
    expect(body.html).toContain('1 year')
    expect(body.html).toContain('Start your membership')

    // The link's mt token round-trips to this gift + recipient.
    const m = body.html.match(/\/redeem\?mt=([^"&\s]+)/)
    expect(m).not.toBeNull()
    const claim = await verifyGiftClaimToken(decodeURIComponent(m![1]!), {
      SESSION_SECRET: BASE_ENV.SESSION_SECRET,
    })
    expect(claim?.giftToken).toBe(token)
    expect(claim?.email).toBe('recip@x.com')
  })

  test('idempotent: a PI already carrying the derived gift_token does not resend', async () => {
    const token = giftTokenForPaymentIntent('pi_gift_1', {
      SESSION_SECRET: BASE_ENV.SESSION_SECRET,
    })
    const pi = buildGiftPI({ term: '1yr', gift_token: token })
    webhookEvent = { type: 'payment_intent.succeeded', data: { object: pi } }
    retrievedPI = pi

    const res = await runWebhook({ RESEND_API_KEY: 'rk_test' })
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'paymentIntents.update')).toBe(false)
    expect(fetchCalls.some((c) => c.url.startsWith('https://api.resend.com'))).toBe(false)
  })

  test('non-gift PI (no kind=gift metadata) — no work', async () => {
    const pi: FakePI = {
      id: 'pi_other',
      client_secret: 's',
      status: 'succeeded',
      metadata: { some_other: 'thing' },
    }
    webhookEvent = { type: 'payment_intent.succeeded', data: { object: pi } }

    const res = await runWebhook()
    expect(res.statusCode).toBe(200)
    expect(fetchCalls.length).toBe(0)
    expect(stripeCalls.some((c) => c.method === 'paymentIntents.update')).toBe(false)
  })

  test('malformed gift PI (bad term) → 500 so Stripe retries', async () => {
    const pi = buildGiftPI({ term: 'lifetime' })
    webhookEvent = { type: 'payment_intent.succeeded', data: { object: pi } }
    retrievedPI = pi

    const res = await runWebhook()
    expect(res.statusCode).toBe(500)
  })
})

describe('giftTokenForPaymentIntent', () => {
  test('is deterministic and high-entropy for a given PI + secret', () => {
    const env = { SESSION_SECRET: BASE_ENV.SESSION_SECRET }
    const a = giftTokenForPaymentIntent('pi_abc', env)
    const b = giftTokenForPaymentIntent('pi_abc', env)
    expect(a).toBe(b) // deterministic → idempotent retries
    expect(a).not.toBe(giftTokenForPaymentIntent('pi_xyz', env)) // per-PI
    expect(a.length).toBeGreaterThan(20) // not guessable from the PI id
  })
})

describe('gift claim (magic-link) token', () => {
  const env = { SESSION_SECRET: BASE_ENV.SESSION_SECRET }

  test('round-trips giftToken + email + name', async () => {
    const mt = await signGiftClaimToken(
      { giftToken: 'gt_1', email: 'r@x.com', name: 'Rae' },
      env,
    )
    expect(await verifyGiftClaimToken(mt, env)).toEqual({
      giftToken: 'gt_1',
      email: 'r@x.com',
      name: 'Rae',
    })
  })

  test('rejects a token signed with a different secret', async () => {
    const mt = await signGiftClaimToken({ giftToken: 'gt_1', email: 'r@x.com' }, env)
    expect(
      await verifyGiftClaimToken(mt, {
        SESSION_SECRET: 'another-secret-0123456789abcdef0123456789',
      }),
    ).toBeNull()
  })
})

describe('POST /api/gift/claim — guards', () => {
  test('500 when the database is not configured', async () => {
    const h = getHandler(CLAIM_PATH)
    const res = makeRes()
    await runHandler(h, makeReq({ method: 'POST', body: { mt: 'x' } }), res)
    expect(res.statusCode).toBe(500)
    expect((res.__json() as { error: string }).error).toBe('database_not_configured')
  })

  test('400 when mt is missing', async () => {
    const h = getHandler(CLAIM_PATH, { DATABASE_URL: 'postgres://x' })
    const res = makeRes()
    await runHandler(h, makeReq({ method: 'POST', body: {} }), res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toBe('token required')
  })

  test('400 expired_link on an unverifiable mt (before any DB call)', async () => {
    const h = getHandler(CLAIM_PATH, { DATABASE_URL: 'postgres://x' })
    const res = makeRes()
    await runHandler(h, makeReq({ method: 'POST', body: { mt: 'not-a-token' } }), res)
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toBe('expired_link')
    // Never reached Stripe or the DB — verification fails first.
    expect(stripeCalls.length).toBe(0)
  })
})
