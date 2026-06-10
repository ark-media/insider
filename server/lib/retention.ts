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

import type { RetentionOffer } from '../../shared/retention.js'
import type { Plan } from './pricing.js'

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

// Best retention coupon to offer the member's plan. Prefers the largest
// percent_off (the plan favors a repeating percent coupon); if none are
// percentage-based, the largest USD amount_off. Null when nothing valid/usable
// is flagged for the plan. Deterministic so re-entering the flow offers the
// same coupon. Pass plan=null to consider only untargeted ("both") coupons.
export function pickRetentionCoupon<T extends RetentionCouponLike>(
  coupons: T[],
  plan: Plan | null = null,
): T | null {
  const usable = coupons.filter(
    (c) => isRetentionCoupon(c) && isUsable(c) && appliesToPlan(c, plan),
  )
  if (usable.length === 0) return null
  const percent = usable.filter((c) => c.percent_off != null)
  if (percent.length > 0) {
    return percent.reduce((a, b) => (b.percent_off! > a.percent_off! ? b : a))
  }
  return usable.reduce((a, b) => (b.amount_off! > a.amount_off! ? b : a))
}

// Flatten a coupon into the client-facing offer DTO.
export function toRetentionOffer(c: RetentionCouponLike): RetentionOffer {
  return {
    couponId: c.id,
    label: c.name,
    percentOff: c.percent_off,
    amountOff: c.amount_off,
    durationMonths: c.duration_in_months ?? null,
  }
}
