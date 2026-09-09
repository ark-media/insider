// What the account page's plan card is allowed to say a member pays.
//
// Under the per-currency `currency_options` scheme every catalog price is
// denominated in USD and carries the other currencies as options, so for a
// non-USD member `price.currency` is 'usd' while `sub.currency` is theirs.
// Quoting `unit_amount` there would be wrong money — but refusing and stopping
// left every member outside the base currency with no price on the card at all,
// when the real figure is one expand away.

import { describe, expect, test } from 'bun:test'
import type Stripe from 'stripe'
import { subscriptionAmount } from './helpers.js'

const sub = (currency: string) => ({ currency }) as Stripe.Subscription
const price = (over: Partial<Stripe.Price>) =>
  ({ id: 'price_1', currency: 'usd', unit_amount: 599, ...over }) as Stripe.Price

/** A Stripe whose price retrieve returns `currency_options`, counting calls. */
function fakeStripe(currencyOptions: Record<string, { unit_amount: number }> | null) {
  let retrieves = 0
  const stripe = {
    prices: {
      retrieve: async () => {
        retrieves += 1
        if (!currencyOptions) throw new Error('boom')
        return price({ currency_options: currencyOptions as Stripe.Price['currency_options'] })
      },
    },
  } as unknown as Stripe
  return { stripe, calls: () => retrieves }
}

describe('subscriptionAmount', () => {
  test('uses unit_amount directly when the currencies agree', async () => {
    const { stripe, calls } = fakeStripe(null)
    expect(await subscriptionAmount(stripe, sub('usd'), price({}))).toBe(599)
    // No second round trip on the common path.
    expect(calls()).toBe(0)
  })

  test('reads the localized amount for a member billed in another currency', async () => {
    // The regression: this returned null, and a GBP member saw no price at all
    // — neither the headline figure nor the "Next charge" cell.
    const { stripe } = fakeStripe({ gbp: { unit_amount: 499 } })
    expect(await subscriptionAmount(stripe, sub('gbp'), price({}))).toBe(499)
  })

  test('never quotes the USD base for a subscription that bills elsewhere', async () => {
    // currency_options came back without the subscription's own currency: still
    // better to show no figure than the wrong one.
    const { stripe } = fakeStripe({ eur: { unit_amount: 549 } })
    expect(await subscriptionAmount(stripe, sub('gbp'), price({}))).toBeNull()
  })

  test('a failed lookup drops the amount rather than the whole request', async () => {
    // The card's real job is the renewal date; a Stripe hiccup here must not
    // take that down with it.
    const { stripe } = fakeStripe(null)
    expect(await subscriptionAmount(stripe, sub('gbp'), price({}))).toBeNull()
  })

  test('a price with no unit_amount quotes nothing', async () => {
    const { stripe } = fakeStripe(null)
    expect(await subscriptionAmount(stripe, sub('usd'), price({ unit_amount: null }))).toBeNull()
  })
})
