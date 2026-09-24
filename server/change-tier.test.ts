// Unit tests for POST /api/stripe/change-tier — the in-app tier/plan/PWYC switch
// (task 14). Focuses on the two behaviours most easily gotten wrong:
//
//   1. A period-end change to an ABOVE-FLOOR PWYC amount must bill that amount
//      (inline price_data on the schedule phase), not silently fall back to the
//      catalog floor price while Neon records the higher number.
//   2. When the subscription already carries a pending change (a 2-phase
//      schedule), the rebuild must preserve the phase covering NOW as phase 0 —
//      taking the last phase would grab the future one and drop the live period.
//
// Harness mirrors my-subscription.test.ts (mock.module('stripe') + a signed
// session cookie driving the registered middleware). No DATABASE_URL, so the
// membership pending writes are skipped — this exercises the Stripe side.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createDevApiHarness, type Middleware } from './test-utils'

type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []

const NOW_SEC = 1_800_000_000 // fixed, comfortably in range for phase math
type Phase = {
  start_date: number
  end_date: number | null
  items: Array<{ price: string; quantity?: number }>
  discounts?: Array<Record<string, unknown>>
}

// Per-test config.
let existingCustomers: Array<{ id: string; email: string }> = []
let currentSub: Record<string, unknown> | null = null
let schedulePhases: Phase[] = []
let productEntitlements: Record<string, string> = {}
// Makes the schedule write throw, so a test can watch what the handler leaves
// behind when the change fails halfway.
let scheduleUpdateFails = false
// What subscriptions.update throws, standing in for Stripe refusing an upgrade
// whose immediate charge failed (payment_behavior: error_if_incomplete).
let subscriptionUpdateError: unknown = null
// The subscription's discounts with coupons expanded — what the route re-reads
// (subscriptions.retrieve, expand discounts.source.coupon) to decide which
// retention coupons survive the change.
let expandedDiscounts: Array<Record<string, unknown>> = []
let activeCoupons: Array<Record<string, unknown>> = []
// What the subscription's price charges in each non-base currency — the
// currency_options Stripe only returns on prices.retrieve with the expand.
let priceCurrencyOptions: Record<string, { unit_amount: number }> = {}

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return { data: existingCustomers.filter((c) => c.email === args.email) }
    },
  }
  subscriptions = {
    list: async (args: { customer: string; status?: string; limit?: number }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      const match =
        currentSub && (currentSub.customer as string) === args.customer ? [currentSub] : []
      return { data: match }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      if (subscriptionUpdateError) throw subscriptionUpdateError
      return { ...currentSub, id }
    },
    retrieve: async (id: string, args?: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id, args] })
      return { ...currentSub, discounts: expandedDiscounts }
    },
  }
  subscriptionSchedules = {
    create: async (args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptionSchedules.create', args: [args] })
      return { id: 'sched_new' }
    },
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'subscriptionSchedules.retrieve', args: [id] })
      return { id, phases: schedulePhases }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptionSchedules.update', args: [id, args] })
      if (scheduleUpdateFails) throw new Error('stripe is having a bad day')
      return { id }
    },
    release: async (id: string) => {
      stripeCalls.push({ method: 'subscriptionSchedules.release', args: [id] })
      return { id }
    },
  }
  products = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'products.retrieve', args: [id] })
      return { id, metadata: { entitlements: productEntitlements[id] ?? '' } }
    },
  }
  prices = {
    // resolveCatalogPrice: floor 800 (monthly) with currency_options for every
    // supported currency, product prod_<tier>.
    list: async (args: { lookup_keys?: string[] }) => {
      stripeCalls.push({ method: 'prices.list', args: [args] })
      const key = args.lookup_keys?.[0] ?? ''
      const base = key.includes('monthly') ? 800 : 8000
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const cur of SUPPORTED_CURRENCIES) {
        if (cur !== 'usd') currency_options[cur] = { unit_amount: base }
      }
      const tierKey = key.replace(/_(monthly|yearly)$/, '')
      return {
        data: [
          {
            id: `price_${key}`,
            product: `prod_${tierKey}`,
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
    retrieve: async (id: string, args?: { expand?: string[] }) => {
      stripeCalls.push({ method: 'prices.retrieve', args: [id, args] })
      // Catalog ids read price_<tier>_<plan>; the product comes back expanded
      // when asked for, the way saveFlowTargetOf reads a schedule phase's tier.
      const productId = `prod_${id.replace(/^price_/, '').replace(/_(monthly|yearly)$/, '')}`
      return {
        id,
        currency: 'usd',
        currency_options: priceCurrencyOptions,
        recurring: { interval: id.includes('yearly') ? 'year' : 'month' },
        product: args?.expand?.includes('product')
          ? { id: productId, metadata: { entitlements: productEntitlements[productId] ?? '' } }
          : productId,
      }
    },
  }
  // A debundle looks for an intro coupon before it writes anything. Empty by
  // default, so pickIntroCoupon finds none and the schedule carries no discount
  // — the discount itself has its own coverage in derive-save-offers.test.ts.
  coupons = {
    list: async (args?: { starting_after?: string }) => {
      stripeCalls.push({ method: 'coupons.list', args: [args] })
      return { data: activeCoupons, has_more: false }
    },
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER mock.module.
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  // Set so the debundle notice actually renders and "sends"; the fetch mock
  // below is what keeps that off the network.
  RESEND_API_KEY: 'rk_test',
}

// --- Outbound fetch mock (Resend) -----------------------------------------
const originalFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  if (url.includes('api.resend.com')) {
    return new Response('{"id":"email_1"}', { status: 200 })
  }
  return new Response('{}', { status: 200 })
}) as typeof fetch

function resendBody(): Record<string, unknown> | null {
  const call = fetchCalls.find((c) => c.url.includes('api.resend.com'))
  return call ? (JSON.parse(String(call.init?.body)) as Record<string, unknown>) : null
}

const PATH = '/api/stripe/change-tier'

function getHandler(): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(PATH)
}

async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

function makeReq(body: unknown, cookie?: string, path: string = PATH): IncomingMessage {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = 'POST'
  stream.url = path
  stream.headers = {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
  }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

function makeRes() {
  let body = ''
  let statusCode = 200
  return {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    headersSent: false,
    setHeader() {},
    getHeader() {
      return undefined
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === 'string' ? chunk : chunk.toString()
    },
    __json: () => JSON.parse(body) as Record<string, unknown>,
  }
}

async function post(
  body: unknown,
  cookie?: string,
  sharedHandler?: Middleware,
  path: string = PATH,
) {
  // A fresh handler per call by default, so each test starts with its own rate
  // limiter; the limiter's own test passes one in to keep the bucket.
  const handler =
    sharedHandler ?? createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(path)
  const req = makeReq(body, cookie, path)
  const res = makeRes()
  await new Promise<void>((resolve, reject) => {
    const orig = res.end.bind(res)
    res.end = ((chunk?: string | Buffer) => {
      orig(chunk)
      resolve()
    }) as typeof res.end
    try {
      handler(req, res as unknown as ServerResponse, (err) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : undefined,
      )
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
  return res
}

// A live subscription for `member@example.com` on the given tier/amount.
function withSub(opts: {
  tier: 'ark-plus' | 'bundle'
  amountCents: number
  scheduleId?: string
}) {
  existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
  productEntitlements = {
    prod_ark_plus: 'ark_plus',
    prod_bundle: 'ark_plus,circle',
  }
  currentSub = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    currency: 'usd',
    schedule: opts.scheduleId ?? null,
    metadata: {},
    items: {
      data: [
        {
          id: 'si_1',
          price: {
            id: 'price_current',
            unit_amount: opts.amountCents,
            currency: 'usd',
            product: `prod_${opts.tier === 'ark-plus' ? 'ark_plus' : 'bundle'}`,
            recurring: { interval: 'month' },
          },
          current_period_end: NOW_SEC + 1000,
        },
      ],
    },
  }
}

beforeEach(() => {
  stripeCalls.length = 0
  existingCustomers = []
  currentSub = null
  schedulePhases = []
  productEntitlements = {}
  scheduleUpdateFails = false
  subscriptionUpdateError = null
  expandedDiscounts = []
  activeCoupons = []
  priceCurrencyOptions = {}
  fetchCalls = []
  // The resolver's price cache is module-level and `bun test` shares one
  // process. Clearing it keeps `prices.list` a reliable signal of whether the
  // catalog was actually consulted — which is what the ordering case below
  // asserts on.
  __resetPriceCacheForTests()
})

describe('POST /api/stripe/change-tier', () => {
  test('401 without a session cookie', async () => {
    const res = await post({ tier: 'ark-plus', plan: 'monthly' })
    expect(res.statusCode).toBe(401)
  })

  test('404 when the member has no live subscription', async () => {
    const res = await post({ tier: 'ark-plus', plan: 'monthly' }, await sessionCookie('member@example.com'))
    expect(res.statusCode).toBe(404)
  })

  test('an authenticated client cannot loop on this endpoint', async () => {
    // Session-authenticated, so the risk isn't enumeration — it's cost. Every
    // call fans out to several Stripe reads before it can decide anything,
    // including the reads a refusal needs, so a client in a loop is expensive
    // even when every answer is "no". Keyed on the session email, which a
    // caller can't rotate by editing the body.
    const handler = getHandler()
    const cookie = await sessionCookie('looper@example.com')
    for (let i = 0; i < 20; i++) {
      const res = await post({ tier: 'bundle', plan: 'monthly' }, cookie, handler)
      expect(res.statusCode).toBe(404)
    }
    const res = await post({ tier: 'bundle', plan: 'monthly' }, cookie, handler)
    expect(res.statusCode).toBe(429)
  })

  test('period-end downgrade to an above-floor PWYC amount bills that amount (not the floor)', async () => {
    // Bundle → Ark+ loses the circle axis, so this lands at period end via a
    // schedule. The chosen $15 is above the $8 Ark+ floor and MUST be billed.
    withSub({ tier: 'bundle', amountCents: 2000 })
    schedulePhases = [
      { start_date: NOW_SEC - 100, end_date: NOW_SEC + 1000, items: [{ price: 'price_bundle_monthly', quantity: 1 }] },
    ]
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1500 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('period_end')

    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    expect(upd).toBeDefined()
    const phases = (upd!.args[1] as { phases: Array<{ items: Array<Record<string, unknown>> }> }).phases
    // Phase 1 is the destination — an inline price for exactly $15, NOT the floor
    // catalog price id.
    const destItem = phases[1].items[0] as {
      price?: string
      price_data?: { unit_amount?: number }
    }
    expect(destItem.price).toBeUndefined()
    expect(destItem.price_data?.unit_amount).toBe(1500)
  })

  test('period-end change over an existing 2-phase schedule preserves the ACTIVE phase as phase 0', async () => {
    // A pending change already exists → the schedule has [active, future]. The
    // rebuild must keep the active (current-period) phase, not the future one.
    withSub({ tier: 'bundle', amountCents: 2000, scheduleId: 'sched_existing' })
    schedulePhases = [
      { start_date: NOW_SEC - 100, end_date: NOW_SEC + 1000, items: [{ price: 'price_bundle_monthly', quantity: 1 }] },
      { start_date: NOW_SEC + 1000, end_date: NOW_SEC + 2000, items: [{ price: 'price_ark_plus_monthly', quantity: 1 }] },
    ]
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)

    // No new schedule is created — the existing one is reused.
    expect(stripeCalls.some((c) => c.method === 'subscriptionSchedules.create')).toBe(false)
    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    const phases = (upd!.args[1] as { phases: Array<{ start_date: number }> }).phases
    // Phase 0 is the active period (start in the past), NOT the future phase.
    expect(phases[0].start_date).toBe(NOW_SEC - 100)
  })

  test('immediate upgrade (gains an axis) updates the sub in place, no schedule', async () => {
    // Ark+ → Bundle gains circle → immediate, prorated.
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('immediate')
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(true)
    expect(stripeCalls.some((c) => c.method === 'subscriptionSchedules.update')).toBe(false)
  })

  test('below-floor custom amount is rejected', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 100 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(400)
  })
})

// ===========================================================================
// The 18+ attestation
//
// Adding the Fold from the account page asks the member to confirm they're 18,
// and the sentence they ticked is stamped on the subscription — the same
// metadata keys the checkout paths write on their Checkout Session, because
// this route has no Session to write to.
//
// Recorded, never enforced: the browser requires the tick, the server does not
// refuse a change that arrives without one. An upgrade is not the place to
// discover a member can't use the membership they already have.
// ===========================================================================
describe('POST /api/stripe/change-tier — 18+ attestation', () => {
  const STATEMENT = 'I confirm that I am 18 years or older.'

  function subMetadata(): Record<string, string> {
    const upd = stripeCalls.find((c) => c.method === 'subscriptions.update')
    return (upd!.args[1] as { metadata: Record<string, string> }).metadata
  }

  test('the sentence the member ticked is stamped on the subscription', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'bundle', plan: 'monthly', age_statement: STATEMENT },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    // Gaining the Fold is always the immediate branch, which is the only one
    // that writes subscription metadata.
    expect(res.__json().timing).toBe('immediate')

    const meta = subMetadata()
    expect(meta.consent_statement_1).toBe(STATEMENT)
    // Our clock, not the browser's — as on the checkout path.
    expect(Date.parse(meta.consent_accepted_at ?? '')).not.toBeNaN()
    // And the change itself still recorded what it always did.
    expect(meta.tier).toBe('bundle')
  })

  test('a change that asked nothing writes no age keys', async () => {
    // Absence has to keep meaning "never asked". A PWYC tweak or a plan switch
    // that writes an empty/false value here would make the record unreadable.
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1500 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(subMetadata().consent_statement_1).toBeUndefined()
    expect(subMetadata().consent_accepted_at).toBeUndefined()
  })

  test('the switch still goes through when no attestation is sent', async () => {
    // The deliberate non-gate: this is a collection, not a refusal.
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(subMetadata().tier).toBe('bundle')
    expect(subMetadata().consent_statement_1).toBeUndefined()
  })

  test('an oversized statement is dropped rather than sent to Stripe', async () => {
    // The string arrives from a client we don't trust to be terse, and Stripe
    // caps a metadata value at 500 characters — a rejected update would fail
    // the whole upgrade over the bookkeeping half of it.
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'bundle', plan: 'monthly', age_statement: 'x'.repeat(401) },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(subMetadata().consent_statement_1).toBeUndefined()
  })
})

// ===========================================================================
// The debundle notice
//
// A debundle is the membership change Stripe does not itself explain:
// one product stops, the other continues at a new price, and Stripe's receipt
// for that price doesn't arrive until the next invoice.
// ===========================================================================
describe('POST /api/stripe/change-tier — debundle notice', () => {
  function stageDebundle() {
    withSub({ tier: 'bundle', amountCents: 2000 })
    schedulePhases = [
      {
        start_date: NOW_SEC - 100,
        end_date: NOW_SEC + 1000,
        items: [{ price: 'price_bundle_monthly', quantity: 1 }],
      },
    ]
  }

  test('dropping the Fold names what stops, what continues, and the new price', async () => {
    stageDebundle()
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', retained_product: 'kept-ark-plus' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('period_end')

    const body = resendBody()
    expect(body).not.toBeNull()
    expect(body!.to).toBe('member@example.com')
    expect(body!.subject).toBe("You've removed The Fold from your membership")
    // A debundle settles at the kept product's catalog floor ($8 monthly).
    expect(String(body!.html)).toContain('$8 a month')
    // What continues must be as loud as what stops, or this reads as a cancel.
    expect(String(body!.html)).toContain('Ark+')
  })

  test('hands back a survey_id so the debundle survey has a row to annotate', async () => {
    // The win-back row the debundle writes is also what the survey-after-cancel
    // step updates, so its id has to come back on the response. There is no
    // DATABASE_URL here, so no row is written and the id is null — what this
    // pins is that the key is part of the contract, since the client reads
    // `survey_id ?? null` and would otherwise silently never submit.
    stageDebundle()
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', retained_product: 'kept-ark-plus' },
      await sessionCookie('member@example.com'),
    )
    expect(res.__json()).toHaveProperty('survey_id')
    expect(res.__json().survey_id).toBeNull()
  })

  test('dropping Ark+ sends the other direction', async () => {
    stageDebundle()
    const res = await post(
      { tier: 'circle', plan: 'monthly', retained_product: 'kept-circle' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(resendBody()!.subject).toBe("You've removed Ark+ from your membership")
  })

  test('a plain upgrade is not a debundle and sends nothing', async () => {
    // Ark+ → Bundle gains an entitlement. The upgrade already has its own email
    // (renderAxisAddedEmail, off the webhook); a "you removed something" notice
    // here would be both wrong and a second message about one change.
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(resendBody()).toBeNull()
  })

  test('a PWYC amount change sends nothing — nothing was removed', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1500 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(resendBody()).toBeNull()
  })

  test('a failed change sends nothing', async () => {
    // The notice is written after the Stripe write commits, so a change that
    // never landed must not be announced.
    stageDebundle()
    scheduleUpdateFails = true
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', retained_product: 'kept-ark-plus' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(502)
    expect(resendBody()).toBeNull()
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

function lastSubUpdate(): Record<string, unknown> {
  const call = [...stripeCalls].reverse().find((c) => c.method === 'subscriptions.update')
  if (!call) throw new Error('no subscriptions.update call recorded')
  return call.args[1] as Record<string, unknown>
}

// F7 — an upgrade that gains an entitlement is access granted now, so it is
// charged now, and a failed charge leaves the subscription untouched.
describe('POST /api/stripe/change-tier — upgrades are paid for up front', () => {
  test('gaining an entitlement invoices immediately and refuses to apply unpaid', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    const update = lastSubUpdate()
    // create_prorations only parked the difference on the NEXT invoice — up to
    // a year out — so the Bundle could be taken on credit.
    expect(update.proration_behavior).toBe('always_invoice')
    expect(update.payment_behavior).toBe('error_if_incomplete')
  })

  test('a same-entitlement PWYC raise keeps the deferred proration', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1500 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    const update = lastSubUpdate()
    expect(update.proration_behavior).toBe('create_prorations')
    expect(update.payment_behavior).toBeUndefined()
  })

  test('a declined card is a clean 402, not a 502 — and nothing is recorded as changed', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    subscriptionUpdateError = Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError',
      code: 'card_declined',
      statusCode: 402,
    })
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(402)
    const body = res.__json() as Record<string, unknown>
    expect(body.code).toBe('payment_failed')
    expect(String(body.error)).toContain('declined')
  })

  test('any other Stripe failure is still a 502', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    subscriptionUpdateError = new Error('stripe is having a bad day')
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(502)
  })
})

// F4 — a retention coupon is priced for one product at one cadence, and must
// not ride a plan/tier change onto something else.
describe('POST /api/stripe/change-tier — retention coupons do not survive a change they no longer fit', () => {
  const discount = (id: string, metadata: Record<string, string>) => ({
    id,
    source: { type: 'coupon', coupon: { id: `coupon_${id}`, metadata } },
  })
  const SUPPORTER = discount('di_supporter', {
    retention_offer: 'true',
    offer_kind: 'supporter_coupon',
    plan: 'monthly',
  })
  const CHECKOUT_PROMO = discount('di_promo', { auto_apply: 'true' })

  function withDiscounts(list: Array<Record<string, unknown>>) {
    expandedDiscounts = list
    ;(currentSub as Record<string, unknown>).discounts = list.map((d) => d.id)
  }

  test('accept the monthly supporter rate → switch to annual: the coupon is dropped', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    withDiscounts([SUPPORTER])
    const res = await post(
      { tier: 'ark-plus', plan: 'yearly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('immediate')
    // Stripe clears a list param with '' — the only discount was the stale one.
    expect(lastSubUpdate().discounts).toBe('')
  })

  test('accept the Ark+ supporter rate → upgrade to Bundle: dropped, other discounts kept', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    withDiscounts([SUPPORTER, CHECKOUT_PROMO])
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    // Kept by DISCOUNT id, so its original term is preserved, not restarted.
    expect(lastSubUpdate().discounts).toEqual([{ discount: 'di_promo' }])
  })

  test('a coupon that still fits is left exactly as it is', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    withDiscounts([SUPPORTER])
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1500 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect('discounts' in lastSubUpdate()).toBe(false)
  })

  test('an undiscounted subscription costs no extra Stripe read', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    await post({ tier: 'bundle', plan: 'monthly' }, await sessionCookie('member@example.com'))
    expect(stripeCalls.some((c) => c.method === 'subscriptions.retrieve')).toBe(false)
  })
})

// F6 — the current tier comes from the price product, never sub.metadata.tier.
describe('POST /api/stripe/change-tier — tier authority', () => {
  test('a live subscription that sells none of our tiers cannot be rewritten into one', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    productEntitlements = {} // the product carries no entitlements stamp
    ;(currentSub as Record<string, unknown>).metadata = { tier: 'bundle' }
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(409)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
  })
})

// A currency_options price states `unit_amount` in USD whatever the member pays
// in. Comparing that with a amount in the subscription's own currency decided
// "nothing changed" and "immediate vs period end" in the wrong money.
describe('POST /api/stripe/change-tier — non-USD subscriptions compare in their own currency', () => {
  function withEurSub(paysEur: number) {
    withSub({ tier: 'ark-plus', amountCents: 800 }) // 800 = the USD base, not what they pay
    ;(currentSub as Record<string, unknown>).currency = 'eur'
    priceCurrencyOptions = { eur: { unit_amount: paysEur } }
  }

  test('lowering a EUR PWYC amount lands at period end, even when it is above the USD base', async () => {
    withEurSub(1500)
    schedulePhases = [
      { start_date: NOW_SEC - 100, end_date: NOW_SEC + 1000, items: [{ price: 'price_current', quantity: 1 }] },
    ]
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1200 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('period_end')
  })

  test('asking for exactly what they pay in EUR is a no-op', async () => {
    withEurSub(1500)
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1500 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().changed).toBe(false)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
  })
})

// subscriptionSchedules.update replaces every phase, so a phase rebuilt without
// its discounts silently loses them.
describe('POST /api/stripe/change-tier — discounts survive a period-end change', () => {
  test('a checkout promo stays on the current phase and carries into the next', async () => {
    withSub({ tier: 'bundle', amountCents: 2000 })
    ;(currentSub as Record<string, unknown>).discounts = ['di_promo']
    expandedDiscounts = [
      { id: 'di_promo', source: { type: 'coupon', coupon: { id: 'c_promo', metadata: {} } } },
    ]
    schedulePhases = [
      {
        start_date: NOW_SEC - 100,
        end_date: NOW_SEC + 1000,
        items: [{ price: 'price_bundle_monthly', quantity: 1 }],
        discounts: [{ discount: 'di_promo', coupon: null, promotion_code: null }],
      },
    ]
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('period_end')

    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    const phases = (upd!.args[1] as { phases: Array<{ discounts?: unknown }> }).phases
    expect(phases[0].discounts).toEqual([{ discount: 'di_promo' }])
    expect(phases[1].discounts).toEqual([{ discount: 'di_promo' }])
  })

  test('a retention coupon priced for the Fold does not ride onto Ark+', async () => {
    withSub({ tier: 'bundle', amountCents: 2000 })
    ;(currentSub as Record<string, unknown>).discounts = ['di_afford']
    expandedDiscounts = [
      {
        id: 'di_afford',
        source: {
          type: 'coupon',
          coupon: {
            id: 'c_afford',
            metadata: { retention_offer: 'true', offer_kind: 'affordability_coupon' },
          },
        },
      },
    ]
    schedulePhases = [
      {
        start_date: NOW_SEC - 100,
        end_date: NOW_SEC + 1000,
        items: [{ price: 'price_bundle_monthly', quantity: 1 }],
      },
    ]
    await post({ tier: 'ark-plus', plan: 'monthly' }, await sessionCookie('member@example.com'))
    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    const phases = (upd!.args[1] as { phases: Array<{ discounts?: unknown }> }).phases
    expect(phases[1].discounts).toBeUndefined()
  })
})

// Accepting a save attaches its coupon. `discounts` REPLACES the list, so a
// member who already had a promo must keep it — a save that quietly strips a
// forever discount leaves them paying more for having said yes.
describe('POST /api/stripe/accept-save-offer', () => {
  const ACCEPT = '/api/stripe/accept-save-offer'
  const supporter = (over: Record<string, unknown> = {}) => ({
    id: 'save20',
    valid: true,
    name: 'Stay 20',
    percent_off: 20,
    amount_off: null,
    currency: null,
    duration: 'repeating',
    duration_in_months: 3,
    metadata: { retention_offer: 'true', offer_kind: 'supporter_coupon', plan: 'monthly' },
    ...over,
  })

  test('keeps the discounts already on the subscription alongside the new coupon', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    ;(currentSub as Record<string, unknown>).discounts = ['di_promo']
    activeCoupons = [supporter()]
    const res = await post(
      { intent: 'cancel-ark-plus', kind: 'supporter_coupon' },
      await sessionCookie('member@example.com'),
      undefined,
      ACCEPT,
    )
    expect(res.statusCode).toBe(200)
    expect(lastSubUpdate().discounts).toEqual([{ discount: 'di_promo' }, { coupon: 'save20' }])
    expect(lastSubUpdate().cancel_at_period_end).toBe(false)
  })

  test('a fixed-amount save with no EUR amount is not offered to a EUR member', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    ;(currentSub as Record<string, unknown>).currency = 'eur'
    activeCoupons = [supporter({ percent_off: null, amount_off: 200, currency: 'usd' })]
    const res = await post(
      { intent: 'cancel-ark-plus', kind: 'supporter_coupon' },
      await sessionCookie('member@example.com'),
      undefined,
      ACCEPT,
    )
    expect(res.statusCode).toBe(409)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
  })

  test('a switch still pending on a schedule gets the coupon on its future phase, not the sub', async () => {
    withSub({ tier: 'ark-plus', amountCents: 8000, scheduleId: 'sched_1' })
    const item = ((currentSub as { items: { data: Array<{ price: Record<string, unknown> }> } })
      .items.data[0])
    item.price.recurring = { interval: 'year' }
    activeCoupons = [supporter()]
    schedulePhases = [
      {
        start_date: NOW_SEC - 100,
        end_date: NOW_SEC + 1000,
        items: [{ price: 'price_ark_plus_yearly', quantity: 1 }],
        discounts: [{ discount: 'di_promo', coupon: null, promotion_code: null }],
      },
      {
        start_date: NOW_SEC + 1000,
        end_date: null,
        items: [{ price: 'price_ark_plus_monthly', quantity: 1 }],
      },
    ]
    const res = await post(
      { intent: 'cancel-ark-plus', kind: 'monthly_switch' },
      await sessionCookie('member@example.com'),
      undefined,
      ACCEPT,
    )
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    const phases = (upd!.args[1] as { phases: Array<{ discounts?: unknown }> }).phases
    expect(phases[0].discounts).toEqual([{ discount: 'di_promo' }])
    expect(phases[1].discounts).toEqual([{ coupon: 'save20' }])
  })
  // A bundle-yearly member with Ark+ monthly booked (a debundle). The account
  // page opens their cancel flow as Ark+, so that is what the server must read:
  // the live bundle price refused the intent outright, and releasing the
  // schedule to attach the coupon would have undone the debundle.
  const pendingDebundle = () => {
    withSub({ tier: 'bundle', amountCents: 25000, scheduleId: 'sched_1' })
    const item = ((currentSub as { items: { data: Array<{ price: Record<string, unknown> }> } })
      .items.data[0])
    item.price.recurring = { interval: 'year' }
    schedulePhases = [
      {
        start_date: NOW_SEC - 100,
        end_date: NOW_SEC + 1000,
        items: [{ price: 'price_bundle_yearly', quantity: 1 }],
      },
      {
        start_date: NOW_SEC + 1000,
        end_date: null,
        items: [{ price: 'price_ark_plus_monthly', quantity: 1 }],
      },
    ]
  }

  test('a booked debundle: the kept Ark+ monthly coupon lands on the pending phase', async () => {
    pendingDebundle()
    activeCoupons = [supporter()]
    const res = await post(
      { intent: 'cancel-ark-plus', kind: 'supporter_coupon' },
      await sessionCookie('member@example.com'),
      undefined,
      ACCEPT,
    )
    expect(res.statusCode).toBe(200)
    expect(stripeCalls.some((c) => c.method === 'subscriptionSchedules.release')).toBe(false)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    const phases = (upd!.args[1] as { phases: Array<{ discounts?: unknown }> }).phases
    expect(phases[0].discounts).toBeUndefined()
    expect(phases[1].discounts).toEqual([{ coupon: 'save20' }])
  })

  test('a booked debundle still refuses a bundle intent', async () => {
    pendingDebundle()
    activeCoupons = [supporter()]
    const res = await post(
      { intent: 'debundle-remove-circle', kind: 'supporter_coupon' },
      await sessionCookie('member@example.com'),
      undefined,
      ACCEPT,
    )
    expect(res.statusCode).toBe(409)
    expect(stripeCalls.some((c) => c.method === 'subscriptionSchedules.update')).toBe(false)
  })

  test('with no debundle booked, a bundle member cannot take the Ark+ coupon', async () => {
    withSub({ tier: 'bundle', amountCents: 25000 })
    activeCoupons = [supporter()]
    const res = await post(
      { intent: 'cancel-ark-plus', kind: 'supporter_coupon' },
      await sessionCookie('member@example.com'),
      undefined,
      ACCEPT,
    )
    expect(res.statusCode).toBe(409)
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
  })
})

// save-offers quotes from the same place accept-save-offer checks, so it never
// shows an offer that accepting would refuse.
describe('GET /api/stripe/save-offers', () => {
  const OFFERS = '/api/stripe/save-offers'

  async function get(intent: string) {
    const handler = createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(OFFERS)
    const req = makeReq(
      {},
      await sessionCookie('member@example.com'),
      `${OFFERS}?intent=${intent}`,
    )
    ;(req as { method?: string }).method = 'GET'
    const res = makeRes()
    await new Promise<void>((resolve, reject) => {
      const orig = res.end.bind(res)
      res.end = ((chunk?: string | Buffer) => {
        orig(chunk)
        resolve()
      }) as typeof res.end
      handler(req, res as unknown as ServerResponse, (err) =>
        err ? reject(err) : reject(new Error('not handled')),
      )
    })
    return res.__json() as { offers: Array<{ kind: string }> }
  }

  test('a booked debundle to Ark+ monthly gets the Ark+ monthly offers', async () => {
    withSub({ tier: 'bundle', amountCents: 25000, scheduleId: 'sched_1' })
    const item = ((currentSub as { items: { data: Array<{ price: Record<string, unknown> }> } })
      .items.data[0])
    item.price.recurring = { interval: 'year' }
    schedulePhases = [
      {
        start_date: NOW_SEC - 100,
        end_date: NOW_SEC + 1000,
        items: [{ price: 'price_bundle_yearly' }],
      },
      {
        start_date: NOW_SEC + 1000,
        end_date: null,
        items: [{ price: 'price_ark_plus_monthly' }],
      },
    ]
    const body = await get('cancel-ark-plus')
    expect(body.offers.map((o) => o.kind)).toEqual(['annual_switch'])
  })

  test('a bundle member with nothing booked gets no Ark+ offers', async () => {
    withSub({ tier: 'bundle', amountCents: 25000 })
    const body = await get('cancel-ark-plus')
    expect(body.offers).toEqual([])
  })
})
