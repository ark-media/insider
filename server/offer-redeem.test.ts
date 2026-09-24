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
//                                untouched, so the roster claim can be handed back.
//   discounts            the coupon for the member's OWN cadence.
//
// Plus the two-phase claim: taken before Stripe, released on failure, and only
// converted to a redemption once Stripe has confirmed.

import { describe, test, expect, afterAll, beforeEach, mock } from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes,
  neonMockModule,
  runMiddleware,
  silenceExpectedConsole,
  type Middleware,
  type SqlCall,
} from './test-utils'

const NOW_SEC = 1_800_000_000

// --- Stripe mock ------------------------------------------------------------

let existingCustomers: Array<{ id: string; email: string }> = []
let currentSub: Record<string, unknown> | null = null
let updateCalls: Array<{ id: string; params: Record<string, unknown> }> = []
// Set to make subscriptions.update fail the way a declined card does.
let declineNextUpdate = false

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
    update: async (id: string, params: Record<string, unknown>) => {
      updateCalls.push({ id, params })
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
    createPreview: async () => ({ amount_due: 14_521 }),
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// --- Neon mock --------------------------------------------------------------

const sqlCalls: SqlCall[] = []
// The roster row this member has, or null for "never invited".
let rosterRow: Record<string, unknown> | null = null
// Whether the conditional claim UPDATE matches — false models "already claimed
// by a request still in flight".
let claimSucceeds = true

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => {
    if (merged.includes('select code, email, cohort')) return rosterRow ? [rosterRow] : []
    if (merged.includes('set claimed_at = now()')) {
      return claimSucceeds && rosterRow ? [{ code: rosterRow.code }] : []
    }
    return []
  }),
)

// Static imports AFTER the mocks so the plugin picks them up.
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'
import {
  WELCOME_OFFER_COHORT,
  WELCOME_OFFER_COUPON_ID,
  WELCOME_OFFER_REDEEM_BY_ISO,
} from './lib/welcome-offer'
import { AGE_STATEMENT, consentStatementKey } from '../shared/checkout-consent'

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-offer',
}

const PATH = '/api/offer/redeem'
const EMAIL = 'reader@example.com'
const CODE = 'CMB-ACDE-FGHJ'

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

// A live Ark+ subscription for EMAIL, on the given cadence.
function withArkPlusSub(interval: 'month' | 'year' = 'month') {
  existingCustomers = [{ id: 'cus_1', email: EMAIL }]
  currentSub = {
    id: 'sub_1',
    customer: 'cus_1',
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

function withRoster(over: Record<string, unknown> = {}) {
  rosterRow = {
    code: CODE,
    email: EMAIL,
    cohort: WELCOME_OFFER_COHORT,
    sent_at: null,
    claimed_at: null,
    redeemed_at: null,
    redeemed_subscription_id: null,
    redeemed_plan: null,
    ...over,
  }
}

silenceExpectedConsole()

beforeEach(() => {
  existingCustomers = []
  currentSub = null
  rosterRow = null
  claimSucceeds = true
  declineNextUpdate = false
  updateCalls = []
  sqlCalls.length = 0
  __resetPriceCacheForTests()
})

afterAll(() => {
  __resetPriceCacheForTests()
})

describe('POST /api/offer/redeem', () => {
  test('moves a monthly member to the Bundle, re-anchored to today', async () => {
    withArkPlusSub('month')
    withRoster()

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { ok: boolean }).ok).toBe(true)

    expect(updateCalls).toHaveLength(1)
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
    withRoster()

    await post({ age_statement: AGE_STATEMENT.self })
    const params = updateCalls[0]!.params
    expect(params.items).toEqual([{ id: 'si_1', price: 'price_bundle_yearly' }])
    expect(params.discounts).toEqual([{ coupon: WELCOME_OFFER_COUPON_ID.yearly }])
  })

  test('records the tier, the code and the 18+ confirmation on the subscription', async () => {
    withArkPlusSub('month')
    withRoster()

    await post({ age_statement: AGE_STATEMENT.self })
    const metadata = updateCalls[0]!.params.metadata as Record<string, string>
    expect(metadata.tier).toBe('bundle')
    expect(metadata.plan).toBe('monthly')
    expect(metadata.welcome_offer_code).toBe(CODE)
    // The list price of what they're now on — the offer is a discount against
    // it, not a different price.
    expect(metadata.amount_cents).toBe('2500')
    expect(metadata[consentStatementKey(0)]).toBe(AGE_STATEMENT.self)
    expect(metadata.consent_accepted_at).toBeTruthy()
  })

  test('claims the roster row BEFORE Stripe, and marks it redeemed after', async () => {
    withArkPlusSub('month')
    withRoster()

    await post({ age_statement: AGE_STATEMENT.self })
    const writes = sqlCalls.map((c) => c.sql)
    const claimAt = writes.findIndex((s) => s.includes('set claimed_at = now()'))
    const redeemAt = writes.findIndex((s) => s.includes('set redeemed_at'))
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(redeemAt).toBeGreaterThan(claimAt)
    expect(writes.some((s) => s.includes('set claimed_at = null'))).toBe(false)
  })

  test('hands the offer back and changes nothing when the card declines', async () => {
    withArkPlusSub('month')
    withRoster()
    declineNextUpdate = true

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(402)
    expect((res.__json() as { code: string }).code).toBe('payment_failed')
    // The claim is released, and nothing is recorded as redeemed.
    const writes = sqlCalls.map((c) => c.sql)
    expect(writes.some((s) => s.includes('set claimed_at = null'))).toBe(true)
    expect(writes.some((s) => s.includes('set redeemed_at'))).toBe(false)
  })

  test('refuses a second, concurrent redemption without touching Stripe', async () => {
    withArkPlusSub('month')
    withRoster()
    claimSucceeds = false

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { reason: string }).reason).toBe('already_redeemed')
    expect(updateCalls).toHaveLength(0)
  })

  test('turns away someone who was never invited', async () => {
    withArkPlusSub('month')
    rosterRow = null

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { reason: string }).reason).toBe('not_invited')
    expect(updateCalls).toHaveLength(0)
  })

  test('turns away a row that has already been redeemed', async () => {
    withArkPlusSub('month')
    withRoster({ redeemed_at: '2026-10-10T00:00:00Z' })

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect((res.__json() as { reason: string }).reason).toBe('already_redeemed')
    expect(updateCalls).toHaveLength(0)
  })

  test('turns away a member with no live subscription', async () => {
    withRoster()

    const res = await post({ age_statement: AGE_STATEMENT.self })
    expect((res.__json() as { reason: string }).reason).toBe('no_subscription')
    expect(updateCalls).toHaveLength(0)
  })

  test('is not a billing endpoint a cross-site form can reach', async () => {
    withArkPlusSub('month')
    withRoster()

    const res = await post({ age_statement: AGE_STATEMENT.self }, { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect(updateCalls).toHaveLength(0)
  })

  test('needs a session at all', async () => {
    withArkPlusSub('month')
    withRoster()

    const res = await post({ age_statement: AGE_STATEMENT.self }, { cookie: '' })
    expect(res.statusCode).toBe(401)
    expect(updateCalls).toHaveLength(0)
  })

  test('the roster deadline is the coupons’ own redeem_by', () => {
    // Oct 31 2026, 23:59:59 Eastern — Eastern is still UTC-4 that night.
    expect(WELCOME_OFFER_REDEEM_BY_ISO).toBe('2026-11-01T03:59:59Z')
  })
})
