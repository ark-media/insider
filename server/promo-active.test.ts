// GET /api/promo/active — which sale applies, and the code that applies it.
//
// This endpoint is what makes the house sale reach a Session at all: the
// Sessions carry `allow_promotion_codes` (so buyers can type their own code)
// and therefore can't also carry a server-set `discounts` array, so checkout
// applies the sale in the browser with the code this returns. A coupon it
// can't name a code for is a coupon nobody gets.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type Stripe from 'stripe'
import { promoRoutes, __resetPromoCacheForTests } from './routes/promo'
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'
import type { Deps } from './lib/route'

// --- catalog + promo fixtures ----------------------------------------------
let coupons: Array<Record<string, unknown>> = []
let promotionCodes: Array<Record<string, unknown>> = []
let couponsListThrows = false

const coupon = (
  id: string,
  fields: {
    percent_off?: number
    amount_off?: number
    currency?: string
    metadata?: Record<string, string>
    name?: string
  },
) => ({
  id,
  valid: true,
  name: fields.name ?? null,
  percent_off: fields.percent_off ?? null,
  amount_off: fields.amount_off ?? null,
  currency: fields.currency ?? null,
  metadata: fields.metadata ?? { auto_apply: 'true' },
})

const code = (value: string, couponId: string, over: Record<string, unknown> = {}) => ({
  code: value,
  active: true,
  customer: null,
  promotion: { type: 'coupon', coupon: couponId },
  ...over,
})

// $5.99/mo, $59.99/yr, $48 and $80 gifts — the same shape for every supported
// currency, since resolvePriceByLookupKey throws on a missing one.
function priceFor(key: string) {
  const unit = key.startsWith('gift_')
    ? key.endsWith('_6mo')
      ? 4800
      : 8000
    : key.endsWith('_yearly')
      ? 5999
      : 599
  const currency_options: Record<string, { unit_amount: number }> = {}
  for (const c of SUPPORTED_CURRENCIES) currency_options[c] = { unit_amount: unit }
  return { id: `price_${key}`, product: `prod_${key}`, unit_amount: unit, currency_options }
}

const stripe = {
  coupons: {
    list: async () => {
      if (couponsListThrows) throw new Error('stripe coupons.list failed')
      return { data: coupons, has_more: false }
    },
  },
  promotionCodes: {
    list: async () => ({ data: promotionCodes, has_more: false }),
  },
  prices: {
    list: async (args: { lookup_keys?: string[] }) => ({
      data: [priceFor(args.lookup_keys?.[0] ?? '')],
    }),
  },
} as unknown as Stripe

// --- harness ----------------------------------------------------------------
const [route] = promoRoutes({
  env: {},
  stripe,
  appBaseUrl: 'http://localhost',
  activator: null as unknown as Deps['activator'],
})

type Reply = { status: number; body: Record<string, unknown> }

async function get(query: string): Promise<Reply> {
  const req = { url: `/api/promo/active?${query}`, method: 'GET' } as IncomingMessage
  let status = 0
  let body = ''
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    end(chunk?: string) {
      status = (res as unknown as { statusCode: number }).statusCode
      body = chunk ?? ''
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  return { status, body: JSON.parse(body) as Record<string, unknown> }
}

beforeEach(() => {
  coupons = []
  promotionCodes = []
  couponsListThrows = false
  __resetPromoCacheForTests()
  __resetPriceCacheForTests()
})

describe('GET /api/promo/active', () => {
  test('returns the sale AND the code that applies it', async () => {
    coupons = [coupon('c1', { percent_off: 20, name: 'Spring sale' })]
    promotionCodes = [code('SPRING60', 'c1')]

    const { status, body } = await get('plan=monthly')
    expect(status).toBe(200)
    expect(body).toEqual({
      active: true,
      code: 'SPRING60',
      name: 'Spring sale',
      kind: 'percent',
      percent_off: 20,
    })
  })

  test('a coupon with no code is not offered — checkout could not apply it', async () => {
    coupons = [coupon('c1', { percent_off: 20 })]
    promotionCodes = []
    expect((await get('plan=monthly')).body).toEqual({ active: false })
  })

  test('never hands out a code reserved for one customer', async () => {
    coupons = [coupon('c1', { percent_off: 20 })]
    promotionCodes = [code('VIPONLY', 'c1', { customer: 'cus_1' })]
    // The endpoint is public: a customer-restricted code would both leak and
    // fail for everyone it leaked to.
    expect((await get('plan=monthly')).body).toEqual({ active: false })
  })

  test('respects plan targeting', async () => {
    coupons = [coupon('c1', { percent_off: 20, metadata: { auto_apply: 'true', plan: 'yearly' } })]
    promotionCodes = [code('YEARONLY', 'c1')]
    expect((await get('plan=monthly')).body).toEqual({ active: false })
    expect((await get('plan=yearly')).body).toMatchObject({ code: 'YEARONLY' })
  })

  test('a promo not marked auto-apply stays code-only', async () => {
    // It still works if a buyer types it — Stripe validates the code — but it
    // is not the sale we apply for everyone.
    coupons = [coupon('c1', { percent_off: 20, metadata: {} })]
    promotionCodes = [code('SECRET', 'c1')]
    expect((await get('plan=monthly')).body).toEqual({ active: false })
  })

  test('ranks in the charge currency, so a foreign fixed discount is skipped', async () => {
    coupons = [
      coupon('c1', { amount_off: 300, currency: 'eur' }),
      coupon('c2', { percent_off: 10 }),
    ]
    promotionCodes = [code('EUR3', 'c1'), code('TEN', 'c2')]
    // In EUR the fixed €3 beats 10% of €5.99; in USD Stripe would reject it
    // outright, so the percentage wins.
    expect((await get('plan=monthly&currency=eur')).body).toMatchObject({ code: 'EUR3' })
    expect((await get('plan=monthly&currency=usd')).body).toMatchObject({ code: 'TEN' })
  })

  test('a gift ignores plan targeting and ranks on the gift price', async () => {
    coupons = [
      coupon('c1', { percent_off: 10, metadata: { auto_apply: 'true', plan: 'yearly' } }),
      coupon('c2', { amount_off: 500, currency: 'usd' }),
    ]
    promotionCodes = [code('TEN', 'c1'), code('FIVEOFF', 'c2')]
    // On an $80 gift, 10% (800c) beats $5 off — and the yearly-targeted coupon
    // is eligible at all only because a gift has no plan.
    expect((await get('term=1yr')).body).toMatchObject({ code: 'TEN' })
  })

  test('400 on a request that names neither a plan nor a gift term', async () => {
    expect((await get('plan=weekly')).status).toBe(400)
  })

  test('a Stripe failure is full price, not a broken checkout', async () => {
    couponsListThrows = true
    const { status, body } = await get('plan=monthly')
    expect(status).toBe(200)
    expect(body).toEqual({ active: false })
  })
})
