// Unit tests for GET /api/stripe/bundle-upgrade-preview — the numbers the
// account page quotes before it moves a single-axis member onto the Bundle.
// The whole point of the endpoint is that the confirm step can say "this
// REPLACES what you pay" with a real figure, so the cases that matter are the
// ones where a figure would be wrong money:
//
//   1. The current-price line is dropped (null) when the subscription bills in
//      a currency_options currency — `unit_amount` is then the USD base, not
//      what the member is charged.
//   2. A catalog price lookup that fails leaves `bundleCents: null` but still
//      returns a preview, so the confirm step renders (and the member can still
//      switch) without price lines.
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
  prices = {
    // Bundle: $25/mo, $250/yr, with EUR at a distinct amount so a test can tell
    // the per-currency floor apart from the USD base.
    list: async (args: { lookup_keys?: string[] }) => {
      const key = args.lookup_keys?.[0] ?? ''
      if (missingLookupKeys.includes(key)) return { data: [] }
      const base = key.endsWith('_monthly') ? 2500 : 25_000
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const cur of SUPPORTED_CURRENCIES) {
        if (cur !== 'usd') currency_options[cur] = { unit_amount: cur === 'eur' ? 2300 : base }
      }
      return {
        data: [
          {
            id: `price_${key}`,
            product: 'prod_bundle',
            unit_amount: base,
            currency: 'usd',
            currency_options,
          },
        ],
      }
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
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const PATH = '/api/stripe/bundle-upgrade-preview'
const EMAIL = 'member@example.com'

function getHandler(): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(PATH)
}

async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function get(cookie?: string) {
  const res = makeFakeRes()
  await runMiddleware(
    getHandler(),
    makeFakeReq({ method: 'GET', url: PATH, ...(cookie ? { cookie } : {}) }),
    res,
  )
  return res
}

type Preview = {
  plan: string
  currency: string
  minorFactor: number
  currentCents: number | null
  bundleCents: number | null
  renewsAt: string | null
}

// A live Ark+ subscription for EMAIL. `priceCurrency` defaults to the sub's own
// currency (the plain USD case); passing a different one models a catalog price
// billed through currency_options.
function withArkPlusSub(opts: {
  currency?: string
  priceCurrency?: string
  amountCents?: number
  interval?: 'month' | 'year'
} = {}) {
  const currency = opts.currency ?? 'usd'
  existingCustomers = [{ id: 'cus_1', email: EMAIL }]
  currentSub = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    currency,
    schedule: null,
    metadata: {},
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
  // The resolver's price cache is module-level and `bun test` shares one
  // process: without this, a sibling suite's bundle amounts serve these cases
  // (and vice versa).
  __resetPriceCacheForTests()
})

afterAll(() => {
  __resetPriceCacheForTests()
})

describe('GET /api/stripe/bundle-upgrade-preview', () => {
  test('401 without a session cookie', async () => {
    const res = await get()
    expect(res.statusCode).toBe(401)
  })

  test('preview is null when the member has no live subscription', async () => {
    const res = await get(await sessionCookie(EMAIL))
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { preview: unknown }).preview).toBeNull()
  })

  test('quotes the bundle price, the current price, and the unchanged renewal date', async () => {
    withArkPlusSub()
    const res = await get(await sessionCookie(EMAIL))
    const { preview } = res.__json() as { preview: Preview }
    expect(preview.plan).toBe('monthly')
    expect(preview.currency).toBe('usd')
    expect(preview.minorFactor).toBe(100)
    expect(preview.currentCents).toBe(800)
    expect(preview.bundleCents).toBe(2500)
    expect(preview.renewsAt).toBe(new Date(NOW_SEC * 1000).toISOString())
  })

  test('prices the bundle in the SUBSCRIPTION currency, not USD', async () => {
    // EUR sub on a USD-based catalog price: the bundle figure comes from
    // currency_options (2300), and the current-price line is dropped rather
    // than quoting the price's USD `unit_amount` as euros.
    withArkPlusSub({ currency: 'eur', priceCurrency: 'usd' })
    const res = await get(await sessionCookie(EMAIL))
    const { preview } = res.__json() as { preview: Preview }
    expect(preview.currency).toBe('eur')
    expect(preview.bundleCents).toBe(2300)
    expect(preview.currentCents).toBeNull()
  })

  test('a failed price lookup leaves bundleCents null but still returns a preview', async () => {
    missingLookupKeys = ['bundle_yearly']
    withArkPlusSub({ interval: 'year' })
    const res = await get(await sessionCookie(EMAIL))
    const { preview } = res.__json() as { preview: Preview }
    expect(preview.plan).toBe('yearly')
    expect(preview.bundleCents).toBeNull()
    expect(preview.currentCents).toBe(800)
  })
})
