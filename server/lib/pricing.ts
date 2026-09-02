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

function priceLookupKey(tier: PricedTier, plan: Plan): string {
  return `${LOOKUP_PREFIX[tier]}_${plan}`
}

// Gifts are one-time SKUs on their own catalog products (scripts/stripe-catalog.ts
// GIFT_CATALOG), lookup-keyed `gift_<prefix>_<term>` — independent of the
// recurring subscription prices. Prices are $48/$80 (Ark+, Community) and
// $75/$130 (Bundle), each with the same 40-currency `currency_options`.
export type GiftTerm = '6mo' | '1yr'

function giftPriceLookupKey(tier: PricedTier, term: GiftTerm): string {
  return `gift_${LOOKUP_PREFIX[tier]}_${term}`
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
const ZERO_DECIMAL_CURRENCIES = ['jpy', 'krw', 'vnd', 'clp'] as const

function isZeroDecimal(currency: string): boolean {
  return (ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(currency.toLowerCase())
}

// Divisor from a Stripe minor-unit amount to its major-unit value for display:
// 1 for zero-decimal currencies, 100 for the rest.
function minorUnitDivisor(currency: string): number {
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
  return resolvePriceByLookupKey(stripe, priceLookupKey(tier, plan))
}

// The one-time gift price for a tier+term, addressed by its `gift_<prefix>_<term>`
// lookup key. Same resolved shape as a subscription price (priceId, productId,
// per-currency floors) with the same loud failure on a missing/mis-provisioned
// currency — gift checkout uses `priceId` directly (fixed amount, not PWYC).
export async function resolveGiftPrice(
  stripe: Stripe,
  tier: PricedTier,
  term: GiftTerm,
): Promise<CatalogPrice> {
  return resolvePriceByLookupKey(stripe, giftPriceLookupKey(tier, term))
}

// Minor units → a human currency string (2500, 'usd' → "$25"). Falls back to a
// bare number if Intl rejects the code. Divides by the currency's minor-unit
// factor, not a hardcoded 100: zero-decimal currencies (¥, ₩, ₫, CLP) store the
// whole-unit figure already, so /100 would under-report them 100×.
//
// A round amount drops its ".00" — cents on a whole number read as a receipt
// rather than a sentence, and every reader here is prose (a member-facing email,
// a validation message). Matches src/lib/currency.ts, which does the same for
// the prices on the site.
//
// Pinned to 'en' rather than the host locale: the site is English-only (see
// shared/format-date.ts for the same rule on dates).
export function formatMinorUnits(amount: number, currency: string): string {
  const value = amount / minorUnitDivisor(currency)
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      ...(Number.isInteger(value) ? { minimumFractionDigits: 0 } : {}),
    }).format(value)
  } catch {
    return `${value} ${currency.toUpperCase()}`
  }
}

// Exported for tests: the cache is module-level and `bun test` shares one
// process, so a suite whose Stripe mock prices things differently from its
// siblings must clear it before and after its own cases.
export function __resetPriceCacheForTests(): void {
  cache.clear()
}

// Resolve any catalog price by lookup_key into ids + per-currency floors, cached
// by key. Throws if no active price carries the key, it has no `unit_amount`, or
// a supported currency is missing from `currency_options` (so a mis-provisioned
// catalog fails loudly rather than silently pricing a currency at the USD number).
async function resolvePriceByLookupKey(
  stripe: Stripe,
  key: string,
): Promise<CatalogPrice> {
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

// Per-currency floors (minor units) for every tier+plan — the data the
// currency-aware client renders and sends. `floors` already carries the whole
// supported-currency set from currency_options, so this is a straight fan-out.
export type TierPricingByCurrency = {
  monthly: Record<SupportedCurrency, number>
  yearly: Record<SupportedCurrency, number>
}

export async function getAllTierPricingByCurrency(
  stripe: Stripe,
): Promise<Record<PricedTier, TierPricingByCurrency>> {
  const tiers = Object.keys(LOOKUP_PREFIX) as PricedTier[]
  const entries = await Promise.all(
    tiers.map(async (tier) => {
      const [monthly, yearly] = await Promise.all([
        resolveCatalogPrice(stripe, tier, 'monthly'),
        resolveCatalogPrice(stripe, tier, 'yearly'),
      ])
      return [tier, { monthly: monthly.floors, yearly: yearly.floors }] as const
    }),
  )
  return Object.fromEntries(entries) as Record<PricedTier, TierPricingByCurrency>
}

// The minor-unit factor per supported currency (100 for two-decimal, 1 for
// zero-decimal). Sent to the client so it converts entered amounts → minor
// units without duplicating Stripe's zero-decimal list.
export function minorUnitFactors(): Record<SupportedCurrency, number> {
  return Object.fromEntries(
    SUPPORTED_CURRENCIES.map((c) => [c, minorUnitDivisor(c)]),
  ) as Record<SupportedCurrency, number>
}
