// Unit tests for POST /api/stripe/change-preview — what a plan change would do,
// quoted before the account page bills it: the Bundle upgrade panel, and the
// billing page's cadence switch and "Change what I pay". The cases that matter
// are the ones where a figure would be wrong money:
//
//   1. Amounts are in the SUBSCRIPTION's currency; the current-price line is
//      dropped (null) when the price is quoted through currency_options.
//   2. Today's charge is asked of Stripe with the same parameters change-tier
//      sends, inline price included for an amount above the minimum.
//   3. Only a member who chose above the minimum gets the amount picker, and
//      it starts at the same proportion above the new minimum.
//
// Harness mirrors my-subscription.test.ts: mock.module('stripe', …) swaps the
// SDK, and a signed session cookie drives the registered middleware.

import { describe, test, expect, afterAll, beforeEach, mock } from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes,
  runMiddleware,
  type Middleware,
} from './test-utils'

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
const NOW_SEC = 1_800_000_000

let existingCustomers: Array<{ id: string; email: string }> = []
let currentSub: Record<string, unknown> | null = null
// Lookup keys the catalog is missing, to model a mis-provisioned / unreachable
// price without breaking the shared resolver cache for the other cases.
let missingLookupKeys: string[] = []
// What invoices.createPreview answers with, and the params it was asked with.
let previewAmountDue: number | Error = 1740
let previewCalls: Array<Record<string, unknown>> = []

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string }) => ({
      data: existingCustomers.filter((c) => c.email === args.email),
    }),
  }
  subscriptions = {
    list: async (args: { customer: string }) => ({
      data: currentSub && (currentSub.customer as string) === args.customer ? [currentSub] : [],
    }),
  }
  invoices = {
    createPreview: async (args: Record<string, unknown>) => {
      previewCalls.push(args)
      if (previewAmountDue instanceof Error) throw previewAmountDue
      return { amount_due: previewAmountDue }
    },
  }
  prices = {
    // Ark+ $8/$80, Bundle $25/$250, with EUR at a distinct amount so a test
    // can tell the per-currency floor apart from the USD base.
    list: async (args: { lookup_keys?: string[] }) => {
      const key = args.lookup_keys?.[0] ?? ''
      if (missingLookupKeys.includes(key)) return { data: [] }
      const bundle = key.startsWith('bundle_')
      const monthly = key.endsWith('_monthly')
      const base = bundle ? (monthly ? 2500 : 25_000) : monthly ? 800 : 8000
      const eur = bundle ? (monthly ? 2300 : 23_000) : monthly ? 750 : 7500
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const cur of SUPPORTED_CURRENCIES) {
        if (cur !== 'usd') currency_options[cur] = { unit_amount: cur === 'eur' ? eur : base }
      }
      return {
        data: [
          {
            id: `price_${key}`,
            product: bundle ? 'prod_bundle' : 'prod_ark_plus',
            unit_amount: base,
            currency: 'usd',
            currency_options,
          },
        ],
      }
    },
  }
  products = {
    retrieve: async (id: string) => ({
      id,
      metadata: { entitlements: id === 'prod_bundle' ? 'ark_plus,circle' : 'ark_plus' },
    }),
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
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const PATH = '/api/stripe/change-preview'
const EMAIL = 'member@example.com'

function getHandler(): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(PATH)
}

async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function post(body: Record<string, unknown>, cookie?: string) {
  const res = makeFakeRes()
  await runMiddleware(
    getHandler(),
    makeFakeReq({
      method: 'POST',
      url: PATH,
      body,
      headers: { origin: BASE_ENV.APP_BASE_URL },
      ...(cookie ? { cookie } : {}),
    }),
    res,
  )
  return res
}

type Preview = {
  tier: string
  plan: string
  currency: string
  minorFactor: number
  currentCents: number | null
  currentPlan: string | null
  floorCents: number
  amountCents: number
  pwyc: { suggestedCents: number; maxCents: number } | null
  timing: string
  dueTodayCents: number | null
  renewsAt: string | null
  startsAt: string | null
  blocked: string | null
}

// A live Ark+ subscription for EMAIL. `priceCurrency` defaults to the sub's own
// currency (the plain USD case); passing a different one models a catalog price
// billed through currency_options.
function withArkPlusSub(opts: {
  currency?: string
  priceCurrency?: string
  amountCents?: number
  interval?: 'month' | 'year'
  metadata?: Record<string, string>
} = {}) {
  const currency = opts.currency ?? 'usd'
  existingCustomers = [{ id: 'cus_1', email: EMAIL }]
  currentSub = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    currency,
    schedule: null,
    metadata: opts.metadata ?? {},
    items: {
      data: [
        {
          id: 'si_1',
          price: {
            id: 'price_ark_plus',
            unit_amount: opts.amountCents ?? 800,
            currency: opts.priceCurrency ?? currency,
            product: 'prod_ark_plus',
            recurring: { interval: opts.interval ?? 'month' },
          },
          current_period_end: NOW_SEC,
        },
      ],
    },
  }
}

beforeEach(() => {
  existingCustomers = []
  currentSub = null
  missingLookupKeys = []
  previewAmountDue = 1740
  previewCalls = []
  // The resolver's price cache is module-level and `bun test` shares one
  // process: without this, a sibling suite's amounts serve these cases.
  __resetPriceCacheForTests()
})

afterAll(() => {
  __resetPriceCacheForTests()
})

const previewOf = (res: { __json: () => unknown }) => (res.__json() as { preview: Preview }).preview

describe('POST /api/stripe/change-preview', () => {
  test('401 without a session cookie', async () => {
    const res = await post({ tier: 'bundle' })
    expect(res.statusCode).toBe(401)
  })

  test('preview is null when the member has no live subscription', async () => {
    const res = await post({ tier: 'bundle' }, await sessionCookie(EMAIL))
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { preview: unknown }).preview).toBeNull()
  })

  test('the Bundle upgrade: both prices, today\'s charge, a renewal one cycle out', async () => {
    withArkPlusSub()
    const before = Date.now()
    const preview = previewOf(await post({ tier: 'bundle' }, await sessionCookie(EMAIL)))
    // No plan asked for: the cadence they're on now.
    expect(preview.plan).toBe('monthly')
    expect(preview.currentCents).toBe(800)
    expect(preview.amountCents).toBe(2500)
    expect(preview.timing).toBe('immediate')
    expect(preview.dueTodayCents).toBe(1740)
    // A minimum payer gets no picker.
    expect(preview.pwyc).toBeNull()
    const renews = Date.parse(preview.renewsAt!)
    expect(renews - before).toBeGreaterThan(27 * 86_400_000)
    expect(renews - before).toBeLessThan(32 * 86_400_000)
  })

  test('asks Stripe for the charge with the same parameters change-tier sends', async () => {
    withArkPlusSub()
    await post({ tier: 'bundle' }, await sessionCookie(EMAIL))
    expect(previewCalls).toHaveLength(1)
    expect(previewCalls[0]).toMatchObject({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_details: {
        items: [{ id: 'si_1', price: 'price_bundle_monthly' }],
        proration_behavior: 'always_invoice',
        billing_cycle_anchor: 'now',
      },
    })
  })

  test('a member who chose above the minimum gets the picker, pre-filled at the same proportion', async () => {
    withArkPlusSub({ amountCents: 1200, metadata: { chose_above_floor: 'true' } })
    const preview = previewOf(
      await post({ tier: 'ark-plus', plan: 'yearly' }, await sessionCookie(EMAIL)),
    )
    expect(preview.pwyc?.suggestedCents).toBe(12000)
    expect(preview.amountCents).toBe(12000)
    // Above the minimum → quoted as an inline price on the catalog product.
    expect(previewCalls[0]).toMatchObject({
      subscription_details: {
        items: [
          {
            id: 'si_1',
            price_data: {
              currency: 'usd',
              product: 'prod_ark_plus',
              unit_amount: 12000,
              recurring: { interval: 'year' },
            },
          },
        ],
      },
    })
  })

  test('changing only the amount opens on what they pay today', async () => {
    withArkPlusSub({ amountCents: 1250, metadata: { chose_above_floor: 'true' } })
    const preview = previewOf(
      await post({ tier: 'ark-plus', plan: 'monthly' }, await sessionCookie(EMAIL)),
    )
    expect(preview.amountCents).toBe(1250)
  })

  test('a lower amount starts at period end, with nothing to pay today', async () => {
    withArkPlusSub({ amountCents: 1200, metadata: { chose_above_floor: 'true' } })
    const preview = previewOf(
      await post(
        { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1000 },
        await sessionCookie(EMAIL),
      ),
    )
    expect(preview.timing).toBe('period_end')
    expect(preview.dueTodayCents).toBeNull()
    expect(preview.startsAt).toBe(new Date(NOW_SEC * 1000).toISOString())
    expect(previewCalls).toHaveLength(0)
  })

  test('a minimum payer asking for a custom amount is refused', async () => {
    withArkPlusSub()
    const res = await post(
      { tier: 'ark-plus', plan: 'yearly', custom_amount_cents: 12000 },
      await sessionCookie(EMAIL),
    )
    expect(res.statusCode).toBe(400)
  })

  test('an amount below the minimum is refused', async () => {
    withArkPlusSub({ amountCents: 1200, metadata: { chose_above_floor: 'true' } })
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 500 },
      await sessionCookie(EMAIL),
    )
    expect(res.statusCode).toBe(400)
  })

  test('a failed charge quote leaves dueTodayCents null but still returns a preview', async () => {
    previewAmountDue = new Error('stripe down')
    withArkPlusSub()
    const preview = previewOf(await post({ tier: 'bundle' }, await sessionCookie(EMAIL)))
    expect(preview.dueTodayCents).toBeNull()
    expect(preview.amountCents).toBe(2500)
  })

  test('prices the change in the SUBSCRIPTION currency, not USD', async () => {
    // EUR sub on a USD-based catalog price: the bundle figure comes from
    // currency_options (2300), and the current-price line is dropped rather
    // than quoting the price's USD `unit_amount` as euros.
    withArkPlusSub({ currency: 'eur', priceCurrency: 'usd' })
    const preview = previewOf(await post({ tier: 'bundle' }, await sessionCookie(EMAIL)))
    expect(preview.currency).toBe('eur')
    expect(preview.amountCents).toBe(2300)
    expect(preview.currentCents).toBeNull()
  })

  test('a gift extension running says the change is blocked, and quotes nothing', async () => {
    withArkPlusSub()
    currentSub!.status = 'trialing'
    const preview = previewOf(await post({ tier: 'bundle' }, await sessionCookie(EMAIL)))
    expect(preview.blocked).toBe('gift_extension')
    expect(previewCalls).toHaveLength(0)
  })

  test('during a gift pause, a lower amount starts when the gift ends', async () => {
    withArkPlusSub({ amountCents: 1200, metadata: { chose_above_floor: 'true' } })
    const giftEnds = NOW_SEC + 150 * 86400
    ;(currentSub as Record<string, unknown>).pause_collection = {
      behavior: 'keep_as_draft',
      resumes_at: giftEnds,
    }
    const preview = previewOf(
      await post(
        { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1000 },
        await sessionCookie(EMAIL),
      ),
    )
    expect(preview.timing).toBe('period_end')
    expect(preview.blocked).toBeNull()
    expect(preview.startsAt).toBe(new Date(giftEnds * 1000).toISOString())
  })

  test('a failed price lookup is a 502, not a preview with made-up numbers', async () => {
    missingLookupKeys = ['bundle_yearly']
    withArkPlusSub({ interval: 'year' })
    const res = await post({ tier: 'bundle' }, await sessionCookie(EMAIL))
    expect(res.statusCode).toBe(502)
  })
})
