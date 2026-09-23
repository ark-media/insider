/// <reference types="bun" />
// Unit tests for server/routes/stripe/helpers.ts.
//
// Narrow on purpose: this pins planFromSubscription's documented contract,
// which promises `null` for a subscription with no usable items, including
// when `items` is absent from the payload entirely. Callers sit on the
// Stripe webhook and on request paths where a throw becomes a 5xx — and on the
// webhook specifically, a 5xx traps the event in Stripe's retry loop.

import { describe, test, expect } from 'bun:test'
import type Stripe from 'stripe'
import {
  existingDiscountParams,
  findLiveSubscription,
  findOrCreateSubscriber,
  phaseDiscountParams,
  planFromSubscription,
  validatePwycAmount,
} from './routes/stripe/helpers'

const sub = (items: unknown): Stripe.Subscription =>
  ({ id: 'sub_1', items }) as unknown as Stripe.Subscription

const withInterval = (interval: string) =>
  sub({ data: [{ price: { recurring: { interval } } }] })

describe('planFromSubscription', () => {
  test('maps the recurring interval to a plan', () => {
    expect(planFromSubscription(withInterval('month'))).toBe('monthly')
    expect(planFromSubscription(withInterval('year'))).toBe('yearly')
  })

  test('returns null for an interval we do not sell', () => {
    expect(planFromSubscription(withInterval('week'))).toBeNull()
  })

  test('returns null — never throws — for a partial subscription payload', () => {
    // `customer.subscription.deleted` can arrive without `items`. Each of these
    // threw before the fix.
    expect(planFromSubscription(sub(undefined))).toBeNull()
    expect(planFromSubscription(sub(null))).toBeNull()
    expect(planFromSubscription(sub({}))).toBeNull()
    expect(planFromSubscription(sub({ data: [] }))).toBeNull()
    expect(planFromSubscription(sub({ data: [{}] }))).toBeNull()
    expect(planFromSubscription(sub({ data: [{ price: {} }] }))).toBeNull()
  })
})

// F9 — both callers index a per-currency map for the floor, and every
// comparison against undefined/NaN is false: a missing floor used to wave ANY
// amount through, one minor unit included.
describe('validatePwycAmount', () => {
  test('no custom amount charges the floor', () => {
    expect(validatePwycAmount(undefined, 800, 'usd')).toEqual({ amountCents: 800 })
    expect(validatePwycAmount(null, 800, 'usd')).toEqual({ amountCents: 800 })
  })

  test('an amount within [floor, max] is charged as given', () => {
    expect(validatePwycAmount(1500, 800, 'usd')).toEqual({ amountCents: 1500 })
    expect(validatePwycAmount(800, 800, 'usd')).toEqual({ amountCents: 800 })
  })

  test('below the floor and above the cap are refused', () => {
    expect('error' in validatePwycAmount(799, 800, 'usd')).toBe(true)
    expect('error' in validatePwycAmount(800 * 1000 + 1_000_000, 800, 'usd')).toBe(true)
  })

  test.each<[string, unknown]>([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -800],
    ['a float', 799.5],
    ['a string', '800'],
  ])('a floor that is %s is an error, never a free pass', (_label, floor) => {
    // The exploit: floor undefined, custom amount 1.
    expect('error' in validatePwycAmount(1, floor as number, 'usd')).toBe(true)
    // …and with no custom amount it must not hand the bad floor on as the price.
    expect('error' in validatePwycAmount(undefined, floor as number, 'usd')).toBe(true)
  })

  test.each<[string, unknown]>([
    ['a float', 1500.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '1500'],
    ['an object', {}],
  ])('a custom amount that is %s is refused, not rounded or defaulted to the floor', (_label, amount) => {
    expect('error' in validatePwycAmount(amount, 800, 'usd')).toBe(true)
  })

  test('HUF and TWD take whole units only — Stripe refuses a stray hundredth', () => {
    expect(validatePwycAmount(350000, 349000, 'huf')).toEqual({ amountCents: 350000 })
    expect('error' in validatePwycAmount(349050, 349000, 'huf')).toBe(true)
    expect('error' in validatePwycAmount(29001, 29000, 'twd')).toBe(true)
    // The catalog's own floor is always payable, whole or not.
    expect(validatePwycAmount(828875, 828875, 'huf')).toEqual({ amountCents: 828875 })
    // Every other two-decimal currency keeps its cents.
    expect(validatePwycAmount(1001, 1000, 'eur')).toEqual({ amountCents: 1001 })
  })
})

// A discount list is REPLACED by any update that passes one, so everything that
// rewrites discounts has to hand the existing ones back first.
describe('existingDiscountParams', () => {
  test('passes each discount back by id, expanded or not', () => {
    const s = { discounts: ['di_1', { id: 'di_2' }] } as unknown as Stripe.Subscription
    expect(existingDiscountParams(s)).toEqual([{ discount: 'di_1' }, { discount: 'di_2' }])
  })

  test('no discounts → an empty list', () => {
    expect(existingDiscountParams({ discounts: [] } as unknown as Stripe.Subscription)).toEqual([])
  })
})

describe('phaseDiscountParams', () => {
  test('keeps whichever reference each phase discount holds, preferring the discount id', () => {
    const phase = [
      { discount: 'di_1', coupon: 'c_ignored', promotion_code: null },
      { discount: null, coupon: null, promotion_code: { id: 'promo_1' } },
      { discount: null, coupon: { id: 'intro' }, promotion_code: null },
      { discount: null, coupon: null, promotion_code: null },
    ] as unknown as Stripe.SubscriptionSchedule.Phase.Discount[]
    expect(phaseDiscountParams(phase)).toEqual([
      { discount: 'di_1' },
      { promotion_code: 'promo_1' },
      { coupon: 'intro' },
    ])
  })

  test('null → nothing', () => {
    expect(phaseDiscountParams(null)).toEqual([])
  })
})

// F11 — `customers.list({ email })` is an exact, case-sensitive match. Checkout
// lowercases what it stores; a session email is whatever Auth0 holds.
describe('by-email customer lookups are robust to case', () => {
  function fakeStripe(customers: Array<{ id: string; email: string }>) {
    const asked: string[] = []
    const created: Array<{ email: string }> = []
    const stripe = {
      customers: {
        list: async ({ email }: { email: string }) => {
          asked.push(email)
          return { data: customers.filter((c) => c.email === email) }
        },
        create: async (args: { email: string }) => {
          created.push(args)
          return { id: 'cus_new', ...args }
        },
      },
      subscriptions: {
        list: async ({ customer }: { customer: string }) => ({
          data: customer === 'cus_lower' ? [{ id: 'sub_live', status: 'active' }] : [],
        }),
      },
    } as unknown as Stripe
    return { stripe, asked, created }
  }

  test('a mixed-case session email still finds the lowercase customer and its live sub', async () => {
    const { stripe, asked } = fakeStripe([{ id: 'cus_lower', email: 'member@example.com' }])
    const sub = await findLiveSubscription(stripe, 'Member@Example.com')
    expect(sub?.id).toBe('sub_live')
    expect(asked).toEqual(['member@example.com', 'Member@Example.com'])
  })

  test('an already-lowercase email costs one list call, not two', async () => {
    const { stripe, asked } = fakeStripe([])
    await findLiveSubscription(stripe, 'member@example.com')
    expect(asked).toEqual(['member@example.com'])
  })

  test('a customer stored under both casings is returned once', async () => {
    const { stripe } = fakeStripe([
      { id: 'cus_lower', email: 'member@example.com' },
      { id: 'cus_mixed', email: 'Member@Example.com' },
    ])
    const c = await findOrCreateSubscriber(stripe, {
      email: 'Member@Example.com',
      reuseExisting: true,
    })
    // Two distinct customers found → the clean one (no active sub) is picked.
    expect(c.id).toBe('cus_mixed')
  })

  test('customers are created lowercase, and never looked up when the email is unproven', async () => {
    const { stripe, asked, created } = fakeStripe([{ id: 'cus_lower', email: 'member@example.com' }])
    const c = await findOrCreateSubscriber(stripe, {
      email: ' Member@Example.com ',
      reuseExisting: false,
    })
    expect(c.id).toBe('cus_new')
    expect(created[0]!.email).toBe('member@example.com')
    expect(asked).toEqual([])
  })
})
