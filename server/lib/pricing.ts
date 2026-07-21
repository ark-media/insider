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

// The currencies the catalog carries (USD base + `currency_options` for the
// rest). Checkout presents one of these; anything else falls back to USD. These
// mirror the localized price table (Stripe purchasing-power presets, column 1).
// Keep in sync with scripts/stripe-catalog.ts CURRENCIES.
export const SUPPORTED_CURRENCIES = [
  'usd', 'gbp', 'eur', 'cad', 'czk', 'dkk', 'huf', 'nok', 'pln', 'ron',
  'rub', 'sek', 'chf', 'aud', 'hkd', 'idr', 'jpy', 'kzt', 'krw', 'myr',
  'nzd', 'php', 'sgd', 'twd', 'thb', 'vnd', 'egp', 'inr', 'ils', 'ngn',
  'qar', 'sar', 'zar', 'tzs', 'aed', 'brl', 'clp', 'cop', 'mxn', 'pen',
] as const
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]

export function isSupportedCurrency(c: string): c is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(c)
}

// Zero-decimal currencies: a Stripe amount is the whole-currency figure, not
// hundredths (¥1300 = 1300, not 130000). The rest are 2-decimal (×100). This is
// the Stripe zero-decimal list intersected with SUPPORTED_CURRENCIES; HUF/TWD
// are 2-decimal (charge-safe as-is) so they are NOT here. Anything not selling
// in these currencies must never divide their amounts by 100.
export const ZERO_DECIMAL_CURRENCIES = ['jpy', 'krw', 'vnd', 'clp'] as const

export function isZeroDecimal(currency: string): boolean {
  return (ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(currency.toLowerCase())
}

// Divisor from a Stripe minor-unit amount to its major-unit value for display:
// 1 for zero-decimal currencies, 100 for the rest.
export function minorUnitDivisor(currency: string): number {
  return isZeroDecimal(currency) ? 1 : 100
}

// A resolved catalog price: the ids checkout needs (the price for the exact
// floor amount, the product for PWYC inline `price_data`) plus the per-currency
// floor in minor units. `floors.usd` is always the price's `unit_amount`; the
// rest come from `currency_options`.
export type CatalogPrice = {
  priceId: string
  productId: string
  floors: Record<SupportedCurrency, number>
}

const PRICE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; price: CatalogPrice }>()

// Resolve the catalog price for a tier+plan by `lookup_key`, with its product id
// and per-currency floors. Throws if no active price carries the lookup_key, it
// has no `unit_amount`, or a supported currency is missing from
// `currency_options` (so a mis-provisioned catalog fails loudly rather than
// silently pricing a currency at the USD number).
export async function resolveCatalogPrice(
  stripe: Stripe,
  tier: PricedTier,
  plan: Plan,
): Promise<CatalogPrice> {
  const key = priceLookupKey(tier, plan)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.price

  const list = await stripe.prices.list({
    lookup_keys: [key],
    active: true,
    limit: 1,
    expand: ['data.currency_options'],
  })
  const price = list.data[0]
  if (!price) {
    throw new Error(
      `No active Stripe price with lookup_key "${key}" (run scripts/stripe-catalog.ts --apply)`,
    )
  }
  if (price.unit_amount == null) {
    throw new Error(`Stripe price ${price.id} (${key}) has no unit_amount`)
  }
  const productId = typeof price.product === 'string' ? price.product : price.product.id
  const opts = price.currency_options ?? {}
  const floors = { usd: price.unit_amount } as Record<SupportedCurrency, number>
  for (const cur of SUPPORTED_CURRENCIES) {
    if (cur === 'usd') continue
    const amount = opts[cur]?.unit_amount
    if (amount == null) {
      throw new Error(
        `Stripe price ${price.id} (${key}) is missing currency_options for "${cur}" ` +
          `(run scripts/stripe-catalog.ts --apply)`,
      )
    }
    floors[cur] = amount
  }
  const resolved: CatalogPrice = { priceId: price.id, productId, floors }
  cache.set(key, { at: now, price: resolved })
  return resolved
}

// The base (USD) list price in cents for a tier+plan. Kept for the pricing route
// and promo math on the USD path; per-currency floors come from
// resolveCatalogPrice.
export async function getPlanPriceCents(
  stripe: Stripe,
  tier: PricedTier,
  plan: Plan,
): Promise<number> {
  return (await resolveCatalogPrice(stripe, tier, plan)).floors.usd
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
