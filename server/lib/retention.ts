// Retention-offer coupon selection. A retention offer is just a Stripe Coupon
// flagged with one metadata key, mirroring the auto-apply checkout promos:
//
//   metadata.retention_offer = "true"  → eligible to be offered in the cancel
//                                         save flow (admin-configurable; the
//                                         percent/amount/duration live on the
//                                         coupon itself).
//
// `coupon.valid` already accounts for redeem_by + max_redemptions, so Stripe
// enforces expiry/limits. The pure helpers take a structural subset so they can
// be unit-tested with plain objects.

import type Stripe from 'stripe'
import type { OfferKind, RetentionOffer, SaveIntent } from '../../shared/retention.js'
import { getPlanPriceCents, type Plan, type PricedTier } from './pricing.js'
import { listActiveCoupons } from './stripe-promos.js'

// USD is the source currency for all our prices (see server/routes/stripe.ts).
// A fixed (amount_off) coupon in any other currency can't be applied
// meaningfully, so we don't offer one.
const CHARGE_CURRENCY = 'usd'

export type RetentionCouponLike = {
  id: string
  valid: boolean
  name: string | null
  percent_off: number | null
  amount_off: number | null
  currency: string | null
  duration?: 'once' | 'repeating' | 'forever' | null
  duration_in_months?: number | null
  metadata?: Record<string, string> | null
}

export function isRetentionCoupon(c: RetentionCouponLike): boolean {
  return c.valid === true && c.metadata?.retention_offer?.toLowerCase() === 'true'
}

// Plan targeting, mirroring the checkout promos (server/lib/stripe-promos.ts):
// metadata.plan = "monthly" | "yearly" targets one plan; absent/"both" applies
// to either. An admin sets this when they want distinct save offers per plan.
// When the member's plan is unknown (null) we offer only untargeted coupons —
// safer than handing a yearly-only deal to a monthly member we can't confirm.
//
// NOTE: null means the OPPOSITE of its sibling stripe-promos.appliesToPlan/
// pickBestCoupon. There, plan=null means "ignore targeting, any coupon
// qualifies" (the gift flow has no plan). Here, null is conservative: target
// nobody we can't confirm. The two are deliberately not interchangeable.
function appliesToPlan(c: RetentionCouponLike, plan: Plan | null): boolean {
  const target = c.metadata?.plan
  if (!target || target === 'both') return true
  return plan !== null && target === plan
}

// Usable as an offer: a percent discount, or a fixed discount already in the
// currency we charge in. A foreign-currency amount_off is dropped (it would be
// subtracted as if it were USD cents — see the stripe-promos currency note).
function isUsable(c: RetentionCouponLike): boolean {
  if (c.percent_off != null) return true
  if (c.amount_off != null && c.currency === CHARGE_CURRENCY) return true
  return false
}

// The largest of a set of usable coupons: prefers the largest percent_off (the
// plan favors a repeating percent coupon); if none are percentage-based, the
// largest USD amount_off. Null for an empty set. Deterministic so re-entering
// the flow offers the same coupon.
function bestOf<T extends RetentionCouponLike>(usable: T[]): T | null {
  if (usable.length === 0) return null
  const percent = usable.filter((c) => c.percent_off != null)
  if (percent.length > 0) {
    return percent.reduce((a, b) => (b.percent_off! > a.percent_off! ? b : a))
  }
  return usable.reduce((a, b) => (b.amount_off! > a.amount_off! ? b : a))
}

// Best retention coupon to offer the member's plan. Null when nothing
// valid/usable is flagged for the plan. Pass plan=null to consider only
// untargeted ("both") coupons.
export function pickRetentionCoupon<T extends RetentionCouponLike>(
  coupons: T[],
  plan: Plan | null = null,
): T | null {
  return bestOf(
    coupons.filter((c) => isRetentionCoupon(c) && isUsable(c) && appliesToPlan(c, plan)),
  )
}

// The offer kinds that are backed by a Stripe coupon (as opposed to a bare plan
// switch). An admin tags a retention coupon with `metadata.offer_kind` so the
// amount for each save is configurable per kind without a code change — the
// discount figures are Ryan-gated config, resolved from Stripe here.
const COUPON_OFFER_KINDS = new Set<OfferKind>([
  'supporter_coupon',
  'affordability_coupon',
  'circle_free_months',
  'perpetual_discount',
])

export function couponOfferKind(c: RetentionCouponLike): OfferKind | null {
  const k = c.metadata?.offer_kind
  return k && COUPON_OFFER_KINDS.has(k as OfferKind) ? (k as OfferKind) : null
}

// Best retention coupon tagged for a specific offer kind (metadata.offer_kind).
// `perpetual_discount` additionally requires a duration: forever coupon, so a
// mistagged bounded coupon can't be served as a perpetual rate.
export function pickOfferCoupon<T extends RetentionCouponLike>(
  coupons: T[],
  kind: OfferKind,
  plan: Plan | null = null,
): T | null {
  return bestOf(
    coupons.filter(
      (c) =>
        isRetentionCoupon(c) &&
        isUsable(c) &&
        appliesToPlan(c, plan) &&
        couponOfferKind(c) === kind &&
        (kind !== 'perpetual_discount' || c.duration === 'forever'),
    ),
  )
}

// Flatten a coupon into the client-facing offer DTO. `kind` describes the save
// this coupon backs (defaults to the legacy single-coupon case, an Ark+
// supporter rate). `forever` is derived from the coupon's Stripe duration.
export function toRetentionOffer(
  c: RetentionCouponLike,
  kind: OfferKind = 'supporter_coupon',
): RetentionOffer {
  return {
    kind,
    couponId: c.id,
    label: c.name,
    percentOff: c.percent_off,
    amountOff: c.amount_off,
    durationMonths: c.duration_in_months ?? null,
    forever: c.duration === 'forever',
  }
}

// Build a plan-switch offer (annual_switch / monthly_switch). The prices let the
// client render concrete savings. An optional coupon rides along: the
// annual→monthly switch attaches a duration: forever coupon that holds the
// annual-effective rate (Decision #5), so it isn't priced above annual.
function planSwitchOffer(
  kind: 'annual_switch' | 'monthly_switch',
  targetPlan: Plan,
  currentPriceCents: number,
  targetPriceCents: number,
  coupon: RetentionCouponLike | null,
): RetentionOffer {
  return {
    kind,
    couponId: coupon?.id ?? null,
    label: coupon?.name ?? null,
    percentOff: coupon?.percent_off ?? null,
    amountOff: coupon?.amount_off ?? null,
    durationMonths: coupon?.duration_in_months ?? null,
    forever: coupon?.duration === 'forever',
    targetPlan,
    currentPriceCents,
    targetPriceCents,
  }
}

// The standalone price a member would pay after a debundle. Shown in the
// debundle confirmation (Flows C/D) before finalizing, and in Flow E's
// keep-just-one step, so the member sees the new price the remaining product
// continues at. Resolved from the Stripe catalog by lookup key (never hardcoded)
// — e.g. circle/monthly → 800 ($8/mo) per scripts/stripe-catalog.ts.
export type StandalonePricePreview = {
  tier: PricedTier
  plan: Plan
  priceCents: number
}

export async function debundlePricePreview(
  stripe: Stripe,
  targetTier: PricedTier,
  plan: Plan,
): Promise<StandalonePricePreview> {
  const priceCents = await getPlanPriceCents(stripe, targetTier, plan)
  return { tier: targetTier, plan, priceCents }
}

// Derive the ordered list of eligible save offers for a subscriber's tier +
// billing cadence, per the cancellation PRD. Returned in the order a flow should
// present them (e.g. annual switch first, supporter coupon on decline). All
// amounts/coupons resolve from Stripe — never hardcoded. Coupon-backed offers
// are omitted when no matching coupon is configured (the flow then falls through
// to reason → confirm), so the plumbing ships before Ryan's amounts are set.
//
// Mappings (Decisions #5/#6):
//   monthly Ark+ → [annual_switch, supporter_coupon]
//   yearly  Ark+ → [monthly_switch (perpetual, annual-effective rate)]
//   circle       → [affordability_coupon]
// Bundle is driven by the debundle flows (C/D/E), which compose these — the
// deriver returns [] for it.
export async function deriveEligibleOffers(
  stripe: Stripe,
  tier: PricedTier,
  plan: Plan,
): Promise<RetentionOffer[]> {
  const coupons = await listActiveCoupons(stripe)
  const offers: RetentionOffer[] = []

  if (tier === 'ark-plus' && plan === 'monthly') {
    const [monthlyCents, yearlyCents] = await Promise.all([
      getPlanPriceCents(stripe, 'ark-plus', 'monthly'),
      getPlanPriceCents(stripe, 'ark-plus', 'yearly'),
    ])
    offers.push(planSwitchOffer('annual_switch', 'yearly', monthlyCents, yearlyCents, null))
    // Prefer a kind-tagged supporter coupon; fall back to any monthly-eligible
    // retention coupon so an existing single-coupon config keeps working.
    const supporter =
      pickOfferCoupon(coupons, 'supporter_coupon', 'monthly') ??
      pickRetentionCoupon(coupons, 'monthly')
    if (supporter) offers.push(toRetentionOffer(supporter, 'supporter_coupon'))
    return offers
  }

  if (tier === 'ark-plus' && plan === 'yearly') {
    // Perpetual move-to-monthly at the annual-effective rate — needs a
    // duration: forever coupon to hold the rate; without it we don't misrepresent
    // the switch, so it is simply not offered.
    const perpetual = pickOfferCoupon(coupons, 'perpetual_discount', 'monthly')
    if (perpetual) {
      const [monthlyCents, yearlyCents] = await Promise.all([
        getPlanPriceCents(stripe, 'ark-plus', 'monthly'),
        getPlanPriceCents(stripe, 'ark-plus', 'yearly'),
      ])
      offers.push(
        planSwitchOffer('monthly_switch', 'monthly', yearlyCents, monthlyCents, perpetual),
      )
    }
    return offers
  }

  if (tier === 'circle') {
    const affordability = pickOfferCoupon(coupons, 'affordability_coupon', plan)
    if (affordability) offers.push(toRetentionOffer(affordability, 'affordability_coupon'))
    return offers
  }

  return offers
}

// Derive the ordered save offers for a flow *intent* (which product is being
// cancelled/debundled) at the member's billing cadence. Thin dispatch over
// deriveEligibleOffers plus the debundle-only 3-months-free case:
//   cancel-ark-plus / debundle-remove-ark-plus → the Ark+ save (Flow A)
//   cancel-circle                              → the Circle affordability save
//   debundle-remove-circle                     → yearly bundles get 3mo Circle
//                                                free; monthly gets no offer
// Amounts/coupons resolve from Stripe; coupon offers the caller must still
// window-suppress per Decision #6.
export async function deriveSaveOffers(
  stripe: Stripe,
  intent: SaveIntent,
  plan: Plan,
): Promise<RetentionOffer[]> {
  switch (intent) {
    case 'cancel-ark-plus':
    case 'debundle-remove-ark-plus':
      return deriveEligibleOffers(stripe, 'ark-plus', plan)
    case 'cancel-circle':
      return deriveEligibleOffers(stripe, 'circle', plan)
    case 'debundle-remove-circle': {
      // Only annual bundle subscribers are offered 3 months of Circle free
      // before removal (Decision #3 / Flow D); monthly goes straight to confirm.
      if (plan !== 'yearly') return []
      const freeMonths = pickOfferCoupon(await listActiveCoupons(stripe), 'circle_free_months', null)
      return freeMonths ? [toRetentionOffer(freeMonths, 'circle_free_months')] : []
    }
  }
}
