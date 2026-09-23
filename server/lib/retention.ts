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
import {
  getPlanPriceCents,
  minorUnitFactors,
  type Plan,
  type PricedTier,
  type SupportedCurrency,
} from './pricing.js'
import { amountOffIn, listActiveCoupons } from './stripe-promos.js'

// Every quote and coupon here is in the member's SUBSCRIPTION currency: that is
// what Stripe will bill, and a fixed coupon is only attachable in a currency it
// carries (amountOffIn). Callers pass sub.currency; USD is only the default.
type QuoteCurrency = SupportedCurrency

function money(currency: QuoteCurrency): { currency: string; minorFactor: number } {
  return { currency, minorFactor: minorUnitFactors()[currency] ?? 100 }
}

export type RetentionCouponLike = {
  id: string
  valid: boolean
  name: string | null
  percent_off: number | null
  amount_off: number | null
  currency: string | null
  currency_options?: Record<string, { amount_off: number }> | null
  duration?: 'once' | 'repeating' | 'forever' | null
  duration_in_months?: number | null
  metadata?: Record<string, string> | null
}

export function isRetentionCoupon(c: RetentionCouponLike): boolean {
  return c.valid === true && c.metadata?.retention_offer?.toLowerCase() === 'true'
}

// Whether a discount ALREADY on a subscription still belongs there once the
// subscription becomes `result`. A retention coupon is priced for one product at
// one cadence — the supporter rate for monthly Ark+, the affordability rate for
// the Fold, the intro rate for whichever single product a debundler kept — and
// Stripe knows none of that: a subscription-level discount follows the
// subscription through any plan or tier change. So a member could accept the
// monthly supporter rate, switch to annual, and take the same percentage off a
// whole year; or collect the debundle intro rate and re-bundle under it.
//
// Reads the marker only (`metadata.retention_offer`), NOT isRetentionCoupon: that
// also requires `valid`, which is about whether a coupon can be redeemed AGAIN.
// An archived or fully-redeemed retention coupon is still a retention coupon on
// the subscriptions that hold it. Anything unmarked — a checkout promo code, a
// Dashboard courtesy discount — is not ours to remove and always stays.
//
// A null tier or plan means "couldn't establish it", and never drops anything on
// that axis: losing a discount the member was promised is the worse error.
export function retentionDiscountStillApplies(
  coupon: Pick<RetentionCouponLike, 'metadata'>,
  result: { tier: PricedTier | 'free' | null; plan: Plan | null },
): boolean {
  if (coupon.metadata?.retention_offer?.toLowerCase() !== 'true') return true
  const targetPlan = coupon.metadata?.plan
  if (targetPlan && targetPlan !== 'both' && result.plan !== null && targetPlan !== result.plan) {
    return false
  }
  if (result.tier === null) return true
  switch (coupon.metadata?.offer_kind) {
    case 'supporter_coupon':
      return result.tier === 'ark-plus'
    case 'affordability_coupon':
      return result.tier === 'circle'
    case DEBUNDLE_INTRO_SLOT:
      // The intro rate is for the single product kept out of a bundle.
      return result.tier === 'ark-plus' || result.tier === 'circle'
    default:
      return true
  }
}

// The `discounts` param for a subscription update that lands the subscription on
// `result`: every current discount except retention coupons that no longer fit
// (see retentionDiscountStillApplies). Null when nothing needs dropping, so the
// caller omits the param and Stripe leaves the discounts exactly as they are.
// Kept discounts are passed back by discount id, which preserves their original
// start and end — re-attaching by coupon would restart a repeating term.
//
// The subscriptions the billing routes hold come from a list call, where
// `discounts` is bare ids, so this re-reads the one subscription with the
// coupons expanded. Skipped entirely for the common undiscounted subscription.
export async function discountsSurvivingChange(
  stripe: Stripe,
  sub: Stripe.Subscription,
  result: { tier: PricedTier | 'free' | null; plan: Plan | null },
): Promise<Array<{ discount: string }> | '' | null> {
  if (!sub.discounts || sub.discounts.length === 0) return null
  const full = await stripe.subscriptions.retrieve(sub.id, {
    expand: ['discounts.source.coupon'],
  })
  const kept: Array<{ discount: string }> = []
  let dropped = false
  for (const d of full.discounts ?? []) {
    if (typeof d === 'string') {
      // Unexpanded → unknown coupon; keep it.
      kept.push({ discount: d })
      continue
    }
    const coupon = d.source?.coupon
    if (coupon && typeof coupon !== 'string' && !retentionDiscountStillApplies(coupon, result)) {
      dropped = true
      continue
    }
    kept.push({ discount: d.id })
  }
  if (!dropped) return null
  // Stripe clears a list param with an empty string, not an empty array.
  return kept.length > 0 ? kept : ''
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

// Usable as an offer in `currency`: a percent discount, or a fixed discount the
// coupon carries in that currency. Anything else Stripe refuses to attach to the
// subscription, so offering it would promise a save that then fails.
function isUsable(c: RetentionCouponLike, currency: QuoteCurrency): boolean {
  if (c.percent_off != null) return true
  return amountOffIn(c, currency) != null
}

// The largest of a set of usable coupons: prefers the largest percent_off (the
// plan favors a repeating percent coupon); if none are percentage-based, the
// largest amount_off in `currency`. Null for an empty set. Deterministic so
// re-entering the flow offers the same coupon.
function bestOf<T extends RetentionCouponLike>(usable: T[], currency: QuoteCurrency): T | null {
  if (usable.length === 0) return null
  const percent = usable.filter((c) => c.percent_off != null)
  if (percent.length > 0) {
    return percent.reduce((a, b) => (b.percent_off! > a.percent_off! ? b : a))
  }
  return usable.reduce((a, b) =>
    (amountOffIn(b, currency) ?? 0) > (amountOffIn(a, currency) ?? 0) ? b : a,
  )
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
  currency: QuoteCurrency = 'usd',
): T | null {
  return bestOf(
    coupons.filter(
      (c) =>
        isRetentionCoupon(c) &&
        isUsable(c, currency) &&
        appliesToPlan(c, plan) &&
        couponOfferKind(c) === kind,
    ),
    currency,
  )
}

// Flatten a coupon into the client-facing offer DTO. `kind` describes the save
// this coupon backs (defaults to an Ark+ supporter rate). `currentPriceCents` is the list price the coupon discounts (the member's
// current plan), so the card can render the design's struck-through
// "$8 $6/month" pair; omit it and the card falls back to the bare discount.
export function toRetentionOffer(
  c: RetentionCouponLike,
  kind: OfferKind = 'supporter_coupon',
  currentPriceCents?: number,
  currency: QuoteCurrency = 'usd',
): RetentionOffer {
  return {
    kind,
    couponId: c.id,
    label: c.name,
    percentOff: c.percent_off,
    amountOff: c.percent_off != null ? null : amountOffIn(c, currency),
    durationMonths: c.duration_in_months ?? null,
    ...money(currency),
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
  currency: QuoteCurrency,
  coupon: RetentionCouponLike | null = null,
): RetentionOffer {
  return {
    kind,
    couponId: coupon?.id ?? null,
    label: coupon?.name ?? null,
    percentOff: coupon?.percent_off ?? null,
    amountOff: coupon && coupon.percent_off == null ? amountOffIn(coupon, currency) : null,
    durationMonths: coupon?.duration_in_months ?? null,
    ...money(currency),
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
export function pickIntroCoupon<T extends RetentionCouponLike>(
  coupons: T[],
  currency: QuoteCurrency = 'usd',
): T | null {
  return bestOf(
    coupons.filter(
      (c) =>
        isRetentionCoupon(c) &&
        isUsable(c, currency) &&
        c.metadata?.offer_kind === DEBUNDLE_INTRO_SLOT,
    ),
    currency,
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
  currency: QuoteCurrency = 'usd',
): Promise<DebundlePrice> {
  const [priceCents, coupons] = await Promise.all([
    getPlanPriceCents(stripe, targetTier, plan, currency),
    listActiveCoupons(stripe),
  ])
  return {
    tier: targetTier,
    plan,
    ...money(currency),
    ...introFor(priceCents, pickIntroCoupon(coupons, currency), currency),
  }
}

// Split a resolved list price into the { priceCents, introCents, introMonths }
// triple the client renders. An intro that doesn't actually reduce the price is
// dropped rather than shown as a no-op discount.
function introFor(
  priceCents: number,
  coupon: RetentionCouponLike | null,
  currency: QuoteCurrency,
): { priceCents: number; introCents: number | null; introMonths: number | null } {
  if (!coupon) return { priceCents, introCents: null, introMonths: null }
  const introCents = discountedCents(
    priceCents,
    coupon.percent_off,
    amountOffIn(coupon, currency),
  )
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
  currency: string
  minorFactor: number
  bundleCents: number
  arkPlus: DebundlePrice
  circle: DebundlePrice
}

export async function bundleBreakdown(
  stripe: Stripe,
  plan: Plan,
  currency: QuoteCurrency = 'usd',
): Promise<BundleBreakdown> {
  const [bundleCents, arkPlusCents, circleCents, coupons] = await Promise.all([
    getPlanPriceCents(stripe, 'bundle', plan, currency),
    getPlanPriceCents(stripe, 'ark-plus', plan, currency),
    getPlanPriceCents(stripe, 'circle', plan, currency),
    listActiveCoupons(stripe),
  ])
  const intro = pickIntroCoupon(coupons, currency)
  const m = money(currency)
  return {
    plan,
    ...m,
    bundleCents,
    arkPlus: { tier: 'ark-plus', plan, ...m, ...introFor(arkPlusCents, intro, currency) },
    circle: { tier: 'circle', plan, ...m, ...introFor(circleCents, intro, currency) },
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
async function deriveEligibleOffers(
  stripe: Stripe,
  tier: PricedTier,
  plan: Plan,
  currency: QuoteCurrency,
): Promise<RetentionOffer[]> {
  const coupons = await listActiveCoupons(stripe)
  const offers: RetentionOffer[] = []

  if (tier === 'ark-plus' && plan === 'monthly') {
    const [monthlyCents, yearlyCents] = await Promise.all([
      getPlanPriceCents(stripe, 'ark-plus', 'monthly', currency),
      getPlanPriceCents(stripe, 'ark-plus', 'yearly', currency),
    ])
    offers.push(planSwitchOffer('annual_switch', 'yearly', monthlyCents, yearlyCents, currency))
    const supporter = pickOfferCoupon(coupons, 'supporter_coupon', 'monthly', currency)
    if (supporter) {
      offers.push(toRetentionOffer(supporter, 'supporter_coupon', monthlyCents, currency))
    }
    return offers
  }

  if (tier === 'ark-plus' && plan === 'yearly') {
    // "Cancel any time — switch to monthly billing", carrying the same discount
    // the monthly card offers so the move isn't a price rise for its term. It's
    // looked up for the plan they're moving TO (monthly), and is the same
    // admin-configured coupon, so both cards move together.
    const [monthlyCents, yearlyCents] = await Promise.all([
      getPlanPriceCents(stripe, 'ark-plus', 'monthly', currency),
      getPlanPriceCents(stripe, 'ark-plus', 'yearly', currency),
    ])
    const discount = pickOfferCoupon(coupons, 'supporter_coupon', 'monthly', currency)
    offers.push(
      planSwitchOffer('monthly_switch', 'monthly', yearlyCents, monthlyCents, currency, discount),
    )
    return offers
  }

  if (tier === 'circle') {
    const affordability = pickOfferCoupon(coupons, 'affordability_coupon', plan, currency)
    if (affordability) {
      const circleCents = await getPlanPriceCents(stripe, 'circle', plan, currency)
      offers.push(
        toRetentionOffer(affordability, 'affordability_coupon', circleCents, currency),
      )
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
// straight to the confirm screen.
export async function deriveSaveOffers(
  stripe: Stripe,
  intent: SaveIntent,
  plan: Plan,
  currency: QuoteCurrency = 'usd',
): Promise<RetentionOffer[]> {
  switch (intent) {
    case 'cancel-ark-plus':
      return deriveEligibleOffers(stripe, 'ark-plus', plan, currency)
    case 'cancel-circle':
      return deriveEligibleOffers(stripe, 'circle', plan, currency)
    case 'debundle-remove-ark-plus':
    case 'debundle-remove-circle':
      return []
  }
}
