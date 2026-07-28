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
import {
  DEBUNDLE_INTRO_SLOT,
  isCouponOfferKind,
  type DebundlePrice,
  type OfferKind,
  type RetentionOffer,
  type SaveIntent,
} from '../../shared/retention.js'
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

// Which save an admin tagged this coupon for (metadata.offer_kind, set on the
// cancellations back office). Every amount/duration is Stripe config resolved
// here, so changing a save's discount never needs a code change. Null when the
// tag is missing or unknown — such a coupon is never offered.
export function couponOfferKind(c: RetentionCouponLike): OfferKind | null {
  const k = c.metadata?.offer_kind
  return isCouponOfferKind(k) ? k : null
}

// Best retention coupon tagged for a specific offer kind (metadata.offer_kind).
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
        couponOfferKind(c) === kind,
    ),
  )
}

// Flatten a coupon into the client-facing offer DTO. `kind` describes the save
// this coupon backs (defaults to the legacy single-coupon case, an Ark+
// supporter rate). `currentPriceCents` is the list price the coupon discounts (the member's
// current plan), so the card can render the design's struck-through
// "$8 $6/month" pair; omit it and the card falls back to the bare discount.
export function toRetentionOffer(
  c: RetentionCouponLike,
  kind: OfferKind = 'supporter_coupon',
  currentPriceCents?: number,
): RetentionOffer {
  return {
    kind,
    couponId: c.id,
    label: c.name,
    percentOff: c.percent_off,
    amountOff: c.amount_off,
    durationMonths: c.duration_in_months ?? null,
    ...(currentPriceCents != null ? { currentPriceCents } : {}),
  }
}

// Build a plan-switch offer (annual_switch / monthly_switch). A switch changes
// the billing cadence at catalog prices; the prices let the client render the
// concrete saving. An optional coupon rides along — the annual→monthly switch
// carries the same bounded discount the monthly card offers, so moving to
// monthly isn't a price rise for its term.
function planSwitchOffer(
  kind: 'annual_switch' | 'monthly_switch',
  targetPlan: Plan,
  currentPriceCents: number,
  targetPriceCents: number,
  coupon: RetentionCouponLike | null = null,
): RetentionOffer {
  return {
    kind,
    couponId: coupon?.id ?? null,
    label: coupon?.name ?? null,
    percentOff: coupon?.percent_off ?? null,
    amountOff: coupon?.amount_off ?? null,
    durationMonths: coupon?.duration_in_months ?? null,
    targetPlan,
    currentPriceCents,
    targetPriceCents,
  }
}

// Apply a coupon's discount to a list amount (minor units), mirroring the
// client's applyCouponDiscount so a quoted intro rate and the rendered price pair
// can't disagree. Null when the coupon carries neither percent nor amount.
// Duplicated rather than shared because the client copy lives in src/lib/currency
// behind Intl helpers this module has no business importing.
export function discountedCents(
  listMinor: number,
  percentOff: number | null | undefined,
  amountOffMinor: number | null | undefined,
): number | null {
  if (percentOff != null) return Math.round(listMinor * (1 - percentOff / 100))
  if (amountOffMinor != null) return Math.max(0, listMinor - amountOffMinor)
  return null
}

// The bounded discount a debundling member lands on, tagged `debundle_intro` in
// the back office. Unlike a save card this is never offered — change-tier
// attaches it to the scheduled phase automatically. Null when unconfigured, in
// which case a debundle simply lands at the standalone catalog price.
export function pickIntroCoupon<T extends RetentionCouponLike>(coupons: T[]): T | null {
  return bestOf(
    coupons.filter(
      (c) =>
        isRetentionCoupon(c) && isUsable(c) && c.metadata?.offer_kind === DEBUNDLE_INTRO_SLOT,
    ),
  )
}

// What one product costs once a bundle is split: the standalone catalog price
// (the ongoing rate) plus the bounded intro rate the member lands on first.
//
// The bundle is a genuine discount on two standalone prices — splitting it
// forfeits that, so the kept product settles at its own catalog price. The intro
// coupon softens the landing for a fixed term. Both figures resolve from Stripe;
// nothing here is hardcoded, and the intro is derived by applying the live coupon
// so the quote can't drift from what gets charged.
//
// Cadence note: a repeating 6-month coupon discounts every invoice inside its
// window. That is six monthly invoices, but only ONE annual invoice — so an
// annual debundler gets a full discounted year, which is the intended (and
// explainable) behaviour, not an accident.
export async function debundlePricePreview(
  stripe: Stripe,
  targetTier: PricedTier,
  plan: Plan,
): Promise<DebundlePrice> {
  const [priceCents, coupons] = await Promise.all([
    getPlanPriceCents(stripe, targetTier, plan),
    listActiveCoupons(stripe),
  ])
  return { tier: targetTier, plan, ...introFor(priceCents, pickIntroCoupon(coupons)) }
}

// Split a resolved list price into the { priceCents, introCents, introMonths }
// triple the client renders. An intro that doesn't actually reduce the price is
// dropped rather than shown as a no-op discount.
function introFor(
  priceCents: number,
  coupon: RetentionCouponLike | null,
): { priceCents: number; introCents: number | null; introMonths: number | null } {
  if (!coupon) return { priceCents, introCents: null, introMonths: null }
  const introCents = discountedCents(priceCents, coupon.percent_off, coupon.amount_off)
  if (introCents === null || introCents >= priceCents) {
    return { priceCents, introCents: null, introMonths: null }
  }
  return { priceCents, introCents, introMonths: coupon.duration_in_months ?? null }
}

// The prices behind the bundle "keep any services?" selector: the current bundle
// price (shown when both are kept) plus what each product costs on its own — its
// standalone catalog price, with the bounded intro rate it lands on first. The
// two rows deliberately do NOT sum to the bundle: that gap is the bundle's
// discount, and showing it is what makes "Keep bundle" argue for itself.
export type BundleBreakdown = {
  plan: Plan
  bundleCents: number
  arkPlus: DebundlePrice
  circle: DebundlePrice
}

export async function bundleBreakdown(stripe: Stripe, plan: Plan): Promise<BundleBreakdown> {
  const [bundleCents, arkPlusCents, circleCents, coupons] = await Promise.all([
    getPlanPriceCents(stripe, 'bundle', plan),
    getPlanPriceCents(stripe, 'ark-plus', plan),
    getPlanPriceCents(stripe, 'circle', plan),
    listActiveCoupons(stripe),
  ])
  const intro = pickIntroCoupon(coupons)
  return {
    plan,
    bundleCents,
    arkPlus: { tier: 'ark-plus', plan, ...introFor(arkPlusCents, intro) },
    circle: { tier: 'circle', plan, ...introFor(circleCents, intro) },
  }
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
//   yearly  Ark+ → [monthly_switch, carrying the same bounded discount]
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
    offers.push(planSwitchOffer('annual_switch', 'yearly', monthlyCents, yearlyCents))
    const supporter = pickOfferCoupon(coupons, 'supporter_coupon', 'monthly')
    if (supporter) offers.push(toRetentionOffer(supporter, 'supporter_coupon', monthlyCents))
    return offers
  }

  if (tier === 'ark-plus' && plan === 'yearly') {
    // "Cancel any time — switch to monthly billing", carrying the same discount
    // the monthly card offers so the move isn't a price rise for its term. It's
    // looked up for the plan they're moving TO (monthly), and is the same
    // admin-configured coupon, so both cards move together.
    const [monthlyCents, yearlyCents] = await Promise.all([
      getPlanPriceCents(stripe, 'ark-plus', 'monthly'),
      getPlanPriceCents(stripe, 'ark-plus', 'yearly'),
    ])
    const discount = pickOfferCoupon(coupons, 'supporter_coupon', 'monthly')
    offers.push(planSwitchOffer('monthly_switch', 'monthly', yearlyCents, monthlyCents, discount))
    return offers
  }

  if (tier === 'circle') {
    const affordability = pickOfferCoupon(coupons, 'affordability_coupon', plan)
    if (affordability) {
      const circleCents = await getPlanPriceCents(stripe, 'circle', plan)
      offers.push(toRetentionOffer(affordability, 'affordability_coupon', circleCents))
    }
    return offers
  }

  return offers
}

// Derive the ordered save offers for a flow *intent* (which product is being
// cancelled/debundled) at the member's billing cadence. Thin dispatch over
// deriveEligibleOffers:
//   cancel-ark-plus → the Ark+ save (Flow A)
//   cancel-circle   → the Circle affordability save (Flow B)
//   either debundle → no card (see below)
// Amounts/coupons resolve from Stripe; coupon offers the caller must still
// window-suppress per Decision #6.
//
// Neither debundle offers a card, and the symmetry is deliberate. A cancel's
// alternative is $0 and total loss, so a discount has something to argue
// against; a debundle's alternative is "pay less, keep one product", which no
// discount on the bundle can beat without giving both away for the price of
// one. So the save is priced into the exit instead — the kept product lands on
// the debundle_intro rate (see debundlePricePreview) — and both flows go
// straight to the confirm screen. Flow C previously reused the Ark+ *cancel*
// offers here, which quoted standalone Ark+ prices to a bundle member and, on
// accept, changed the bundle's cadence without ever debundling.
export async function deriveSaveOffers(
  stripe: Stripe,
  intent: SaveIntent,
  plan: Plan,
): Promise<RetentionOffer[]> {
  switch (intent) {
    case 'cancel-ark-plus':
      return deriveEligibleOffers(stripe, 'ark-plus', plan)
    case 'cancel-circle':
      return deriveEligibleOffers(stripe, 'circle', plan)
    case 'debundle-remove-ark-plus':
    case 'debundle-remove-circle':
      return []
  }
}
