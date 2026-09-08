// POST /api/admin/promos — the wiring between the back-office form and Stripe.
//
// The interesting part is the per-buyer limits: they live on the promotion
// CODE, not the coupon, and a minimum spend has to be restated in every
// currency we sell in or Stripe refuses the code outside USD ("The supported
// currencies of your promotion code (usd) must include the currency of the
// object"). That fan-out happens here, so it's pinned here.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'

type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []
let codeCreateThrows: string | null = null

// $80/yr, with a currency_options entry for every supported currency (the
// per-currency floors the minimum is scaled against). GBP is deliberately
// cheaper than USD so the scaling is visible rather than 1:1.
function priceFor(key: string) {
  const currency_options: Record<string, { unit_amount: number }> = {}
  for (const c of SUPPORTED_CURRENCIES) {
    currency_options[c] = { unit_amount: c === 'gbp' ? 4000 : 8000 }
  }
  return { id: `price_${key}`, product: 'prod_1', unit_amount: 8000, currency_options }
}

class FakeStripe {
  constructor(_key: string) {}
  coupons = {
    create: async (args: unknown) => {
      stripeCalls.push({ method: 'coupons.create', args: [args] })
      return { id: 'co_new', valid: true, metadata: {}, duration: 'once', times_redeemed: 0 }
    },
    del: async (id: string) => {
      stripeCalls.push({ method: 'coupons.del', args: [id] })
      return { deleted: true }
    },
    list: async () => ({ data: [], has_more: false }),
  }
  promotionCodes = {
    create: async (args: unknown) => {
      stripeCalls.push({ method: 'promotionCodes.create', args: [args] })
      if (codeCreateThrows) throw new Error(codeCreateThrows)
      return {
        code: (args as { code: string }).code,
        max_redemptions: null,
        times_redeemed: 0,
        expires_at: null,
        restrictions: { first_time_transaction: false, minimum_amount: null },
      }
    },
    list: async () => ({ data: [], has_more: false }),
  }
  prices = {
    list: async (args: { lookup_keys?: string[] }) => ({
      data: [priceFor(args.lookup_keys?.[0] ?? '')],
    }),
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER mock.module so the plugin picks up the fake Stripe.
import { createDevApiHarness, silenceExpectedConsole, type Middleware } from './test-utils'
import { makeFakeReq, makeFakeRes, runMiddleware } from './test-utils'
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const PATH = '/api/admin/promos'

function getHandler(): Middleware {
  return createDevApiHarness(devApiPlugin(BASE_ENV)).getHandler(PATH)
}

async function adminCookie(): Promise<string> {
  const token = await signSessionToken({ email: 'a@b.co', roles: ['admin'] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function post(body: Record<string, unknown>) {
  const res = makeFakeRes()
  await runMiddleware(
    getHandler(),
    makeFakeReq({ method: 'POST', url: PATH, body, cookie: await adminCookie() }),
    res,
  )
  return res
}

function lastCodeCreateArgs(): Record<string, unknown> {
  const call = [...stripeCalls].reverse().find((c) => c.method === 'promotionCodes.create')
  if (!call) throw new Error('no promotionCodes.create call recorded')
  return call.args[0] as Record<string, unknown>
}

silenceExpectedConsole()

beforeEach(() => {
  stripeCalls.length = 0
  codeCreateThrows = null
  __resetPriceCacheForTests()
})

const BASE_PROMO = {
  discountType: 'percent',
  percentOff: 15,
  duration: 'once',
  code: 'SPRING60',
}

describe('POST /api/admin/promos — per-buyer limits', () => {
  test('puts them on the code, not the coupon', async () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString()
    const res = await post({
      ...BASE_PROMO,
      firstTimeOnly: true,
      codeMaxRedemptions: 3,
      codeExpiresAt: expires,
    })
    expect(res.statusCode).toBe(200)

    const args = lastCodeCreateArgs()
    expect(args.max_redemptions).toBe(3)
    expect(args.expires_at).toBe(Math.floor(Date.parse(expires) / 1000))
    expect(args.restrictions).toMatchObject({ first_time_transaction: true })
    // The coupon keeps only its own global limits.
    const coupon = stripeCalls.find((c) => c.method === 'coupons.create')
      ?.args[0] as Record<string, unknown>
    expect(coupon.max_redemptions).toBeUndefined()
  })

  test('restates a minimum spend in every currency we sell in', async () => {
    const res = await post({ ...BASE_PROMO, minimumAmountCents: 10000 })
    expect(res.statusCode).toBe(200)

    const restrictions = lastCodeCreateArgs().restrictions as {
      minimum_amount: number
      minimum_amount_currency: string
      currency_options: Record<string, { minimum_amount: number }>
    }
    expect(restrictions.minimum_amount).toBe(10000)
    expect(restrictions.minimum_amount_currency).toBe('usd')
    // Every supported currency except USD, which Stripe derives from the
    // top-level pair and rejects if we send it here.
    expect(Object.keys(restrictions.currency_options).sort()).toEqual(
      SUPPORTED_CURRENCIES.filter((c) => c !== 'usd')
        .slice()
        .sort(),
    )
    // GBP's floor is half of USD's in this catalog, so its minimum is too.
    expect(restrictions.currency_options.gbp.minimum_amount).toBe(5000)
    expect(restrictions.currency_options.eur.minimum_amount).toBe(10000)
  })

  test('no limits asked for → no restrictions sent', async () => {
    await post(BASE_PROMO)
    const args = lastCodeCreateArgs()
    expect(args.restrictions).toBeUndefined()
    expect(args.max_redemptions).toBeUndefined()
    // And no catalog lookup: nothing needed scaling.
    expect(stripeCalls.some((c) => c.method === 'prices.list')).toBe(false)
  })

  test('a rejected code rolls the coupon back', async () => {
    codeCreateThrows = 'The promotion code `SPRING60` already exists.'
    const res = await post({ ...BASE_PROMO, firstTimeOnly: true })
    expect(res.statusCode).toBe(409)
    expect(stripeCalls.some((c) => c.method === 'coupons.del')).toBe(true)
  })

  test('a limit the coupon cannot honour is refused before anything is created', async () => {
    const res = await post({ ...BASE_PROMO, maxRedemptions: 10, codeMaxRedemptions: 50 })
    expect(res.statusCode).toBe(400)
    expect(stripeCalls).toEqual([])
  })
})
