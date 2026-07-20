// Plan prices come from the Stripe catalog — the single source of truth for
// what we charge. Never hardcode amounts. Prices are addressed by `lookup_key`
// (e.g. `ark_plus_monthly`), created by scripts/stripe-catalog.ts, so the
// resolver never depends on a price id pinned in an env var.

import type Stripe from 'stripe'

export type Plan = 'monthly' | 'yearly'

// The three sellable tiers (`free` is not a SKU). Each maps to a catalog
// product whose prices carry `<prefix>_<plan>` lookup keys.
export type PricedTier = 'ark-plus' | 'circle' | 'bundle'

const LOOKUP_PREFIX: Record<PricedTier, string> = {
  'ark-plus': 'ark_plus',
  circle: 'circle',
  bundle: 'bundle',
}

// Pay at least this multiple of the plan's base price and the membership is a
// Founding one. Founding Member is cut for launch (§5) — the multiple is kept
// here (and as inert catalog metadata) so a later revival is config-only. Still
// served to the client so the checkout promise and the honoured threshold can't
// drift; task 13 removes the promise.
export const FOUNDING_MULTIPLE = 2

export function priceLookupKey(tier: PricedTier, plan: Plan): string {
  return `${LOOKUP_PREFIX[tier]}_${plan}`
}

const PRICE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; cents: number }>()

// The base (USD) list price in cents for a tier+plan, read from the catalog
// price with the matching lookup_key. Throws if no active price carries that
// lookup_key or it has no fixed unit_amount. Per-currency floors live in the
// price's `currency_options`; this returns the USD base used for PWYC / promo
// math on the USD path.
export async function getPlanPriceCents(
  stripe: Stripe,
  tier: PricedTier,
  plan: Plan,
): Promise<number> {
  const key = priceLookupKey(tier, plan)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.cents

  const list = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 })
  const price = list.data[0]
  if (!price) {
    throw new Error(
      `No active Stripe price with lookup_key "${key}" (run scripts/stripe-catalog.ts --apply)`,
    )
  }
  if (price.unit_amount == null) {
    throw new Error(`Stripe price ${price.id} (${key}) has no unit_amount`)
  }
  cache.set(key, { at: now, cents: price.unit_amount })
  return price.unit_amount
}

export type TierPricing = { monthly_cents: number; yearly_cents: number }

// All sellable tiers, each with both plan amounts. Used by /api/pricing.
export async function getAllTierPricing(
  stripe: Stripe,
): Promise<Record<PricedTier, TierPricing>> {
  const tiers = Object.keys(LOOKUP_PREFIX) as PricedTier[]
  const entries = await Promise.all(
    tiers.map(async (tier) => {
      const [monthly_cents, yearly_cents] = await Promise.all([
        getPlanPriceCents(stripe, tier, 'monthly'),
        getPlanPriceCents(stripe, tier, 'yearly'),
      ])
      return [tier, { monthly_cents, yearly_cents }] as const
    }),
  )
  return Object.fromEntries(entries) as Record<PricedTier, TierPricing>
}
