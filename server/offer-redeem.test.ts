// POST /api/offer/redeem — the ICMB welcome offer's one money-moving call.
//
// What's pinned here is the shape of the single `subscriptions.update`, because
// every field in it is load-bearing and a wrong one bills the wrong amount on
// the wrong day:
//
//   billing_cycle_anchor 'now'   the new term starts today, so the invoice this
//                                raises IS the first Bundle term — which is
//                                where a `duration: once` coupon has to land.
//   proration_behavior   always_invoice   credit the unused Ark+ time and settle
//                                on the spot.
//   payment_behavior     error_if_incomplete   a decline leaves the subscription
//                                untouched.
//   discounts            the coupon for the member's OWN cadence.
//
// Plus what stands in for a lock with no roster: eligibility read off the
// member's own subscription, and Stripe's idempotency key on the one write.

import { describe, test, expect, afterAll, beforeEach, mock } from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes,
  runMiddleware,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

const NOW_SEC = 1_800_000_000

// --- Stripe mock ------------------------------------------------------------

let existingCustomers: Array<{ id: string; email: string }> = []
let currentSub: Record<string, unknown> | null = null
let updateCalls: Array<{
  id: string
  params: Record<string, unknown>
  opts?: { idempotencyKey?: string }
}> = []
// Set to make subscriptions.update fail the way a declined card does.
let declineNextUpdate = false
// Set to make it fail the way Stripe answers a key already in flight.
let idempotencyConflictNextUpdate = false
// Set to make the post-charge metadata write (no `items`) fail.
let failMetadataWrite = false
let previewCalls: Array<Record<string, unknown>> = []

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string }) => ({
      data: existingCustomers.filter((c) => c.email === args.email),
    }),
  }
  products = {
    retrieve: async (id: string) => ({
      id,
      metadata: { entitlements: id === 'prod_bundle' ? 'ark_plus,circle' : 'ark_plus' },
    }),
  }
  prices = {
    list: async (args: { lookup_keys?: string[] }) => {
      const key = args.lookup_keys?.[0] ?? ''
      const base = key.endsWith('_monthly') ? 2500 : 25_000
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const cur of SUPPORTED_CURRENCIES) {
        if (cur !== 'usd') currency_options[cur] = { unit_amount: base }
      }
      return {
        data: [
          { id: `price_${key}`, product: 'prod_bundle', unit_amount: base, currency: 'usd', currency_options },
        ],
      }
    },
  }
  subscriptions = {
    list: async (args: { customer: string }) => ({
      data: currentSub && (currentSub.customer as string) === args.customer ? [currentSub] : [],
    }),
    retrieve: async () => currentSub,
    update: async (
      id: string,
      params: Record<string, unknown>,
      opts?: { idempotencyKey?: string },
    ) => {
      updateCalls.push({ id, params, opts })
      if (failMetadataWrite && !params.items) throw new Error('Stripe blip')
      if (idempotencyConflictNextUpdate) {
        idempotencyConflictNextUpdate = false
        throw Object.assign(new Error('There is currently another in-progress request'), {
          type: 'StripeIdempotencyError',
          statusCode: 409,
        })
      }
      if (declineNextUpdate) {
        throw Object.assign(new Error('Your card was declined.'), {
          type: 'StripeCardError',
          code: 'card_declined',
        })
      }
      return {
        ...currentSub,
        id,
        latest_invoice: 'in_new_1',
        items: { data: [{ id: 'si_1', current_period_end: NOW_SEC + 86_400 }] },
      }
    },
  }
  invoices = {
    createPreview: async (params: Record<string, unknown>) => {
      previewCalls.push(params)
      return { amount_due: 14_521 }
    },
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER the mocks so the plugin picks them up.
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'
import {
  WELCOME_OFFER_COHORT,
  WELCOME_OFFER_COUPON_ID,
  WELCOME_OFFER_ELIGIBLE_BEFORE_ISO,
  WELCOME_OFFER_REDEEM_BY_ISO,
} from './lib/welcome-offer'
import { AGE_STATEMENT, consentStatementKey } from '../shared/checkout-consent'

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const PATH = '/api/offer/redeem'
const EMAIL = 'reader@example.com'
const BEFORE_LAUNCH = Math.floor(Date.parse(WELCOME_OFFER_ELIGIBLE_BEFORE_ISO) / 1000) - 86_400

function getHandler(path: string): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(path)
}

async function sessionCookie(email: string): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await signSessionToken({ email, roles: [] }, BASE_ENV)}`
}

async function post(body: unknown = {}, opts: { cookie?: string; origin?: string } = {}) {
  const cookie = opts.cookie ?? (await sessionCookie(EMAIL))
  const res = makeFakeRes()
  await runMiddleware(
    getHandler(PATH),
    makeFakeReq({
      method: 'POST',
      url: PATH,
      body,
      cookie,
      headers: { origin: opts.origin ?? BASE_ENV.APP_BASE_URL },
    }),
    res,
  )
  return res
}

// A live Ark+ subscription for EMAIL, on the given cadence, from before launch.
function withArkPlusSub(interval: 'month' | 'year' = 'month') {
  existingCustomers = [{ id: 'cus_1', email: EMAIL }]
  currentSub = {
    id: 'sub_1',
    customer: 'cus_1',
    created: BEFORE_LAUNCH,
    default_payment_method: 'pm_card_1',
    status: 'active',
    currency: 'usd',
    schedule: null,
    discounts: [],
    metadata: { tier: 'ark-plus' },
    items: {
      data: [
        {
          id: 'si_1',
          price: {
            id: 'price_ark_plus',
            unit_amount: interval === 'month' ? 800 : 8000,
            currency: 'usd',
            product: 'prod_ark_plus',
            recurring: { interval },
          },
          current_period_end: NOW_SEC,
        },
      ],
    },
  }
}

silenceExpectedConsole()

beforeEach(() => {
  existingCustomers = []
  currentSub = null
  declineNextUpdate = false
  idempotencyConflictNextUpdate = false
  failMetadataWrite = false
  updateCalls = []
  previewCalls = []
  __resetPriceCacheForTests()
})

afterAll(() => {
  __resetPriceCacheForTests()
})

describe('POST /api/offer/redeem', () => {
  test('moves a monthly member to the Bundle, re-anchored to today', async () => {
    withArkPlusSub('month')

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { ok: boolean }).ok).toBe(true)

    // The charge, then the metadata write that dates it.
    expect(updateCalls).toHaveLength(2)
    const params = updateCalls[0]!.params
    expect(params.billing_cycle_anchor).toBe('now')
    expect(params.proration_behavior).toBe('always_invoice')
    expect(params.payment_behavior).toBe('error_if_incomplete')
    // The item is swapped in place — same item id, Bundle price for the
    // cadence the member already had.
    expect(params.items).toEqual([{ id: 'si_1', price: 'price_bundle_monthly' }])
    expect(params.discounts).toEqual([{ coupon: WELCOME_OFFER_COUPON_ID.monthly }])
  })

  test('gives an annual member the annual coupon and the annual price', async () => {
    withArkPlusSub('year')

    await post({ age_statement: AGE_STATEMENT.self })
    const params = updateCalls[0]!.params
    expect(params.items).toEqual([{ id: 'si_1', price: 'price_bundle_yearly' }])
    expect(params.discounts).toEqual([{ coupon: WELCOME_OFFER_COUPON_ID.yearly }])
  })

  test('marks the subscription as the offer’s, in the charge and then the date', async () => {
    withArkPlusSub('month')

    await post({ age_statement: AGE_STATEMENT.self })
    expect(updateCalls).toHaveLength(2)
    const metadata = updateCalls[0]!.params.metadata as Record<string, string>
    expect(metadata.tier).toBe('bundle')
    expect(metadata.plan).toBe('monthly')
    expect(metadata.welcome_offer).toBe(WELCOME_OFFER_COHORT)
    expect(metadata.welcome_offer_plan).toBe('monthly')
    // The list price of what they're now on — the offer is a discount against
    // it, not a different price.
    expect(metadata.amount_cents).toBe('2500')

    // Anything time-dependent stays OUT of the charging call, or a second
    // submission would present different parameters under the same key.
    expect(metadata.welcome_offer_redeemed_at).toBeUndefined()
    expect(metadata.consent_accepted_at).toBeUndefined()
    const after = updateCalls[1]!.params.metadata as Record<string, string>
    expect(Date.parse(after.welcome_offer_redeemed_at!)).not.toBeNaN()
    expect(after[consentStatementKey(0)]).toBe(AGE_STATEMENT.self)
    expect(after.consent_accepted_at).toBeTruthy()
  })

  test('charges under a key made of the subscription and the card on file', async () => {
    withArkPlusSub('month')

    await post({ age_statement: AGE_STATEMENT.self })
    expect(updateCalls[0]!.opts?.idempotencyKey).toBe(
      `welcome-offer:${WELCOME_OFFER_COHORT}:sub_1:pm_card_1`,
    )
  })

  test('a new card is a new key, so a retry after a decline is a real retry', async () => {
    withArkPlusSub('month')
    declineNextUpdate = true
    await post({ age_statement: AGE_STATEMENT.self })

    declineNextUpdate = false
    currentSub = { ...currentSub, default_payment_method: 'pm_card_2' }
    await post({ age_statement: AGE_STATEMENT.self })
    expect(updateCalls[0]!.opts?.idempotencyKey).not.toBe(updateCalls[1]!.opts?.idempotencyKey)
  })

  test('changes nothing when the card declines', async () => {
    withArkPlusSub('month')
    declineNextUpdate = true

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(402)
    expect((res.__json() as { code: string }).code).toBe('payment_failed')
    // No follow-up metadata write: nothing was redeemed.
    expect(updateCalls).toHaveLength(1)
  })

  test('answers a second click still in flight with a wait, not an error', async () => {
    withArkPlusSub('month')
    idempotencyConflictNextUpdate = true

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(409)
    const body = res.__json() as { code?: string; reason?: string }
    expect(body.code).toBe('in_progress')
    expect(body.reason).toBeUndefined()
    expect(updateCalls).toHaveLength(1)
  })

  test('reports success when Stripe charged but the date write failed', async () => {
    withArkPlusSub('month')
    failMetadataWrite = true

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { ok: boolean }).ok).toBe(true)
  })

  test('turns away a subscription that started after launch', async () => {
    withArkPlusSub('month')
    currentSub = { ...currentSub, created: BEFORE_LAUNCH + 2 * 86_400 }

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { reason: string }).reason).toBe('not_eligible')
    expect(updateCalls).toHaveLength(0)
  })

  test('turns away a member who has already taken it', async () => {
    withArkPlusSub('month')
    currentSub = { ...currentSub, metadata: { welcome_offer: WELCOME_OFFER_COHORT } }

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect((res.__json() as { reason: string }).reason).toBe('already_bundle')
    expect(updateCalls).toHaveLength(0)
  })

  test('turns away a member with no live subscription', async () => {

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect((res.__json() as { reason: string }).reason).toBe('no_subscription')
    expect(updateCalls).toHaveLength(0)
  })

  test('is not a billing endpoint a cross-site form can reach', async () => {
    withArkPlusSub('month')

    const res = await post({ age_statement: AGE_STATEMENT.self }, { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect(updateCalls).toHaveLength(0)
  })

  test('needs a session at all', async () => {
    withArkPlusSub('month')

    const res = await post({ age_statement: AGE_STATEMENT.self }, { cookie: '' })
    expect(res.statusCode).toBe(401)
    expect(updateCalls).toHaveLength(0)
  })

  test('the deadline is the coupons’ own redeem_by', () => {
    // Oct 31 2026, 23:59:59 Eastern — Eastern is still UTC-4 that night.
    expect(WELCOME_OFFER_REDEEM_BY_ISO).toBe('2026-11-01T03:59:59Z')
  })
})

describe('GET /api/offer/check', () => {
  async function check() {
    const res = makeFakeRes()
    await runMiddleware(
      getHandler('/api/offer/check'),
      makeFakeReq({ method: 'GET', url: '/api/offer/check', cookie: await sessionCookie(EMAIL) }),
      res,
    )
    return res
  }

  test('previews with the same discounts the redemption will apply', async () => {
    withArkPlusSub('month')
    currentSub = { ...currentSub, discounts: ['di_checkout_promo'] }

    const res = await check()
    expect(res.statusCode).toBe(200)
    // The top-level list replaces the subscription's own discounts in a
    // preview, so a surviving promo must be restated alongside the coupon.
    expect(previewCalls[0]?.discounts).toEqual([
      { discount: 'di_checkout_promo' },
      { coupon: WELCOME_OFFER_COUPON_ID.monthly },
    ])

    await post({ age_statement: AGE_STATEMENT.self })
    expect(updateCalls[0]?.params.discounts).toEqual(previewCalls[0]?.discounts)
  })
})
