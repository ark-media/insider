// The pay-what-you-can rules behind a plan change: who picks an amount, and
// what the picker starts at (server/routes/stripe/plan-change.ts).

import { describe, test, expect, mock } from 'bun:test'

mock.module('@neondatabase/serverless', () => ({
  neon: () => () => Promise.resolve([]),
  __esModule: true,
}))

import {
  CHOSE_ABOVE_FLOOR_KEY,
  amountChoiceOpen,
  destinationItem,
  suggestedAmount,
} from './routes/stripe/plan-change'

describe('amountChoiceOpen', () => {
  test('a member stamped at checkout keeps it, even back at the minimum', () => {
    expect(amountChoiceOpen({ metadata: { [CHOSE_ABOVE_FLOOR_KEY]: 'true' } }, 800, 800)).toBe(true)
  })

  test('paying above the minimum counts, for subscriptions from before the stamp', () => {
    expect(amountChoiceOpen({ metadata: {} }, 1200, 800)).toBe(true)
  })

  test('a member at the minimum with no stamp gets no amount controls', () => {
    expect(amountChoiceOpen({ metadata: {} }, 800, 800)).toBe(false)
  })

  test('an unreadable amount or minimum withholds them', () => {
    expect(amountChoiceOpen({ metadata: {} }, null, 800)).toBe(false)
    expect(amountChoiceOpen({ metadata: {} }, 1200, null)).toBe(false)
  })
})

describe('suggestedAmount', () => {
  test('carries the proportion above the minimum onto the new plan', () => {
    // $12 on an $8 minimum is 1.5×; the $80 annual minimum becomes $120.
    expect(suggestedAmount(1200, 800, 8000, 'usd')).toBe(12000)
  })

  test('rounds to a whole unit of the currency', () => {
    // 1.5 × $25 = $37.50 → $38.
    expect(suggestedAmount(1200, 800, 2500, 'usd')).toBe(3800)
  })

  test('zero-decimal currencies round in whole yen', () => {
    expect(suggestedAmount(1500, 1000, 3333, 'jpy')).toBe(5000)
  })

  test('HUF and TWD charge in whole units only', () => {
    const v = suggestedAmount(150000, 100000, 333333, 'huf')
    expect(v % 100).toBe(0)
  })

  test('a member at or below the minimum starts at the new minimum', () => {
    expect(suggestedAmount(800, 800, 8000, 'usd')).toBe(8000)
    expect(suggestedAmount(null, 800, 8000, 'usd')).toBe(8000)
  })
})

describe('destinationItem', () => {
  const catalog = { priceId: 'price_cat', productId: 'prod_cat', floors: {} as never }

  test('the minimum bills the catalog Price', () => {
    expect(destinationItem(catalog, 8000, 8000, 'usd', 'yearly')).toEqual({ price: 'price_cat' })
  })

  test('above it bills an inline price on the catalog product', () => {
    expect(destinationItem(catalog, 12000, 8000, 'usd', 'yearly')).toEqual({
      price_data: {
        currency: 'usd',
        product: 'prod_cat',
        unit_amount: 12000,
        recurring: { interval: 'year' },
        tax_behavior: 'exclusive',
      },
    })
  })
})
