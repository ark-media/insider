import { describe, expect, test } from 'bun:test'
import { GIFT_PRICE_DOLLARS } from './gift'

// The gift page's prices. server/gift-matrix-pricing.test.ts pins the same
// table against what scripts/stripe-catalog.ts provisions (monthly ×6, yearly).
describe('GIFT_PRICE_DOLLARS', () => {
  test('Ark+ $48/$80, the Fold $114/$190, Bundle $150/$250', () => {
    expect(GIFT_PRICE_DOLLARS).toEqual({
      'ark-plus': { '6mo': 48, '1yr': 80 },
      circle: { '6mo': 114, '1yr': 190 },
      bundle: { '6mo': 150, '1yr': 250 },
    })
  })
})
