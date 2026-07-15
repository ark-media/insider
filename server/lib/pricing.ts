// Plan prices come from the configured Stripe Price objects — the single
// source of truth for what we charge. Never hardcode amounts: read the Stripe
// Price's unit_amount and cache it briefly (prices change rarely).

import type Stripe from 'stripe'
import type { Env } from './route.js'

export type Plan = 'monthly' | 'yearly'

// Pay at least this multiple of the plan's base price and the membership is a
// Founding one. Enforced at checkout (server/routes/stripe.ts stamps the
// subscription) and served to the client via /api/pricing, so the threshold the
// pricing page promises and the one we actually honour can't drift apart.
export const FOUNDING_MULTIPLE = 2

function priceIdForPlan(env: Env, plan: Plan): string | undefined {
  return plan === 'monthly' ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_YEARLY
}

const PRICE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; cents: number }>()

// The plan's list price in cents (USD), read from its Stripe Price. Throws if
// the price isn't configured or has no fixed unit_amount.
export async function getPlanPriceCents(
  stripe: Stripe,
  env: Env,
  plan: Plan,
): Promise<number> {
  const priceId = priceIdForPlan(env, plan)
  if (!priceId) {
    throw new Error(
      `No Stripe price configured for "${plan}" (set STRIPE_PRICE_${plan.toUpperCase()})`,
    )
  }
  const now = Date.now()
  const hit = cache.get(priceId)
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.cents

  const price = await stripe.prices.retrieve(priceId)
  if (price.unit_amount == null) {
    throw new Error(`Stripe price ${priceId} has no unit_amount`)
  }
  cache.set(priceId, { at: now, cents: price.unit_amount })
  return price.unit_amount
}
