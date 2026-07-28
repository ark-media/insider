/// <reference types="bun" />
// Unit tests for server/routes/stripe/helpers.ts.
//
// Narrow on purpose: this pins planFromSubscription's documented contract,
// which promises `null` for a subscription with no usable items but used to
// throw when `items` was absent from the payload entirely. Callers sit on the
// Stripe webhook and on request paths where a throw becomes a 5xx — and on the
// webhook specifically, a 5xx traps the event in Stripe's retry loop.

import { describe, test, expect } from 'bun:test'
import type Stripe from 'stripe'
import { planFromSubscription } from './routes/stripe/helpers'

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
