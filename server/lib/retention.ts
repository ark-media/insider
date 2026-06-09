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

// Usable as an offer: a percent discount, or a fixed discount already in the
// currency we charge in. A foreign-currency amount_off is dropped (it would be
// subtracted as if it were USD cents — see the stripe-promos currency note).
function isUsable(c: RetentionCouponLike): boolean {
  if (c.percent_off != null) return true
  if (c.amount_off != null && c.currency === CHARGE_CURRENCY) return true
  return false
}

// Best retention coupon to offer. Prefers the largest percent_off (the plan
// favors a repeating percent coupon); if none are percentage-based, the largest
// USD amount_off. Null when nothing valid/usable is flagged. Deterministic so
// re-entering the flow offers the same coupon.
export function pickRetentionCoupon<T extends RetentionCouponLike>(
  coupons: T[],
): T | null {
  const usable = coupons.filter((c) => isRetentionCoupon(c) && isUsable(c))
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
