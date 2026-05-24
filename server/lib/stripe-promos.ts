// Stripe is the source of truth for promotions. A promo is just a Stripe
// Coupon; two metadata keys drive checkout behavior (both editable on a coupon
// without recreating it, so an admin backoffice or the Stripe dashboard can
// toggle them):
//
//   metadata.auto_apply = "true"   → applied automatically at checkout (else
//                                     it requires a code; deny-by-default)
//   metadata.plan = "monthly"|"yearly" (omitted = both) → plan targeting
//
// `coupon.valid` already accounts for redeem_by + max_redemptions, so expiry
// and limits are enforced by Stripe.

import type Stripe from 'stripe'
import type { Plan } from './pricing.js'

// USD is the source currency for all our prices (see server/routes/stripe.ts);
// Adaptive Pricing converts the discounted total into the buyer's currency at
// checkout. A coupon is ranked/applied against that USD source, so a fixed
// (amount_off) coupon must itself be in USD — one in any other currency can't
// be applied meaningfully.
const CHARGE_CURRENCY = 'usd'

// Minimal structural subset of Stripe.Coupon the logic needs, so the pure
// helpers can be unit-tested with plain objects.
export type CouponLike = {
  id: string
  valid: boolean
  name: string | null
  percent_off: number | null
  amount_off: number | null
  currency: string | null
  metadata?: Record<string, string> | null
}

export function isAutoApply(c: CouponLike): boolean {
  return c.valid === true && c.metadata?.auto_apply?.toLowerCase() === 'true'
}

export function appliesToPlan(c: CouponLike, plan: Plan): boolean {
  const target = c.metadata?.plan
  return !target || target === plan
}

// Discount this coupon yields on a base amount, in cents. Fixed discounts are
// clamped to the base (never negative) and ignored unless they're in the
// currency we charge in — a foreign-currency amount_off would otherwise be
// subtracted as if it were USD cents.
export function discountCents(c: CouponLike, baseCents: number): number {
  if (c.percent_off != null) return Math.round((baseCents * c.percent_off) / 100)
  if (c.amount_off != null && c.currency === CHARGE_CURRENCY) {
    return Math.min(baseCents, c.amount_off)
  }
  return 0
}

// Best auto-applicable coupon for a plan, ranked by actual discount on the
// given base price — so percentage and fixed coupons compare correctly. Null
// if nothing applies.
export function pickBestCoupon<T extends CouponLike>(
  coupons: T[],
  plan: Plan,
  baseCents: number,
): T | null {
  let best: T | null = null
  let bestDiscount = 0
  for (const c of coupons) {
    if (!isAutoApply(c) || !appliesToPlan(c, plan)) continue
    const d = discountCents(c, baseCents)
    if (d > bestDiscount) {
      best = c
      bestDiscount = d
    }
  }
  return best
}

// Lists all coupons (paginated). Callers filter with the pure helpers above.
export async function listActiveCoupons(stripe: Stripe): Promise<Stripe.Coupon[]> {
  const all: Stripe.Coupon[] = []
  let startingAfter: string | undefined
  for (let i = 0; i < 20; i++) {
    const page = await stripe.coupons.list({ limit: 100, starting_after: startingAfter })
    all.push(...page.data)
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }
  return all
}
