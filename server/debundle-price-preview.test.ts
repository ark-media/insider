// Unit test for the debundle price-preview helper: it resolves the target
// standalone price from the Stripe catalog by lookup key (never hardcoded).
// Circle standalone is $8/mo (800 cents) per scripts/stripe-catalog.ts.

import { describe, test, expect } from 'bun:test'
import type Stripe from 'stripe'
import { SUPPORTED_CURRENCIES } from './lib/pricing'
import { debundlePricePreview } from './lib/retention'

// Minimal Stripe stub: only prices.list is exercised by resolveCatalogPrice.
// Monthly floor 800, yearly 8000, with currency_options for every supported
// currency so resolveCatalogPrice doesn't throw on a missing option. (The
// resolver caches per lookup key across the process, so a cache hit from
// another test file may serve the value without hitting this stub — every mock
// in the suite agrees on 800/8000, so the resolved amount is stable regardless.)
function fakeStripe(): Stripe {
  return {
    prices: {
      list: async (args: { lookup_keys?: string[] }) => {
        const key = args.lookup_keys?.[0] ?? ''
        const base = key.includes('monthly') ? 800 : 8000
        const currency_options: Record<string, { unit_amount: number }> = {}
        for (const cur of SUPPORTED_CURRENCIES) {
          if (cur !== 'usd') currency_options[cur] = { unit_amount: base }
        }
        return {
          data: [
            { id: `price_${key}`, product: `prod_${key}`, unit_amount: base, currency: 'usd', currency_options },
          ],
        }
      },
    },
  } as unknown as Stripe
}

describe('debundlePricePreview', () => {
  test('returns Circle standalone at $8/mo (800 cents) for the circle target', async () => {
    const preview = await debundlePricePreview(fakeStripe(), 'circle', 'monthly')
    expect(preview).toEqual({ tier: 'circle', plan: 'monthly', priceCents: 800 })
  })

  test('resolves the Ark+ yearly standalone price', async () => {
    const preview = await debundlePricePreview(fakeStripe(), 'ark-plus', 'yearly')
    expect(preview).toEqual({ tier: 'ark-plus', plan: 'yearly', priceCents: 8000 })
  })
})
