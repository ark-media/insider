import { describe, expect, test } from 'bun:test'
import { GIFT_TRIAL_TOKENS_KEY, giftTrialTokensFor, giftTrialTokensOf } from './gift-trial'

// A tagged-template stand-in for the Neon client that answers the gift query.
function fakeSql(rows: Array<{ redemption_token: string; tier: string }>) {
  return (async () => rows) as never
}

describe('giftTrialTokensFor', () => {
  test('only gifts that pay for an axis the plan needs, newest first as returned', async () => {
    const sql = fakeSql([
      { redemption_token: 'a', tier: 'circle' },
      { redemption_token: 'b', tier: 'ark-plus' },
      { redemption_token: 'c', tier: 'bundle' },
    ])
    expect(await giftTrialTokensFor(sql, 'auth0|x', 'ark-plus')).toEqual(['b', 'c'])
    expect(await giftTrialTokensFor(sql, 'auth0|x', 'bundle')).toEqual(['a', 'b', 'c'])
  })

  test('stays inside Stripe’s 500-character metadata value', async () => {
    const token = 'x'.repeat(43)
    const rows = Array.from({ length: 20 }, (_, i) => ({
      redemption_token: `${token}${String(i).padStart(2, '0')}`.slice(-43),
      tier: 'ark-plus',
    }))
    const tokens = await giftTrialTokensFor(fakeSql(rows), 'auth0|x', 'ark-plus')
    expect(tokens.join(',').length).toBeLessThanOrEqual(500)
    expect(tokens.length).toBeGreaterThan(0)
  })
})

describe('giftTrialTokensOf', () => {
  test('parses the comma-joined list, tolerating absence and blanks', () => {
    expect(giftTrialTokensOf({ [GIFT_TRIAL_TOKENS_KEY]: 'a, b,,c' })).toEqual(['a', 'b', 'c'])
    expect(giftTrialTokensOf({})).toEqual([])
    expect(giftTrialTokensOf(null)).toEqual([])
  })
})
