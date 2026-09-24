// GET /api/pricing — the catalog every pricing card and checkout reads.
//
// Covered here: that the success response is edge-cacheable per country (so a
// traffic spike doesn't send every new instance to Stripe), that a failure is
// not, and that a burst of cold requests resolves each price once.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type Stripe from 'stripe'
import { pricingRoutes } from './routes/pricing'
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'
import type { Deps } from './lib/route'

let listCalls: string[] = []
let listThrows = false

const stripe = {
  prices: {
    list: async (args: { lookup_keys?: string[] }) => {
      const key = args.lookup_keys?.[0] ?? ''
      listCalls.push(key)
      if (listThrows) throw new Error('stripe prices.list failed')
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const c of SUPPORTED_CURRENCIES) currency_options[c] = { unit_amount: 599 }
      return {
        data: [{ id: `price_${key}`, product: `prod_${key}`, unit_amount: 599, currency_options }],
      }
    },
  },
} as unknown as Stripe

const [route] = pricingRoutes({
  env: {},
  stripe,
  appBaseUrl: 'http://localhost',
  activator: null as unknown as Deps['activator'],
})

async function get(country?: string) {
  const req = {
    url: '/api/pricing',
    method: 'GET',
    headers: country ? { 'x-vercel-ip-country': country } : {},
  } as unknown as IncomingMessage
  let status = 0
  let body = ''
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(chunk?: string) {
      status = (res as unknown as { statusCode: number }).statusCode
      body = chunk ?? ''
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  return { status, body: JSON.parse(body) as Record<string, unknown>, headers }
}

beforeEach(() => {
  listCalls = []
  listThrows = false
  __resetPriceCacheForTests()
})
// The price cache is module-level and shared across suites in one process;
// leaving these mock prices in it would reprice whichever suite runs next.
afterEach(() => __resetPriceCacheForTests())

describe('GET /api/pricing', () => {
  test('is edge-cacheable, keyed on the geo header', async () => {
    const { status, body, headers } = await get('DE')
    expect(status).toBe(200)
    expect(body.default_currency).toBe('eur')
    expect(headers['cache-control']).toBe('public, s-maxage=60, stale-while-revalidate=360')
    // Without this one country's default currency would be served to another.
    expect(headers['vary']).toBe('X-Vercel-IP-Country')
  })

  test('a Stripe failure is not made cacheable', async () => {
    listThrows = true
    const { status, headers } = await get('US')
    expect(status).toBe(502)
    expect(headers['cache-control']).toBeUndefined()
  })

  test('a burst of cold requests looks each price up once', async () => {
    await Promise.all(Array.from({ length: 20 }, () => get('US')))
    expect(listCalls.length).toBeGreaterThan(0)
    expect(new Set(listCalls).size).toBe(listCalls.length)
  })
})
