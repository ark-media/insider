// Stripe is the source of truth for promotions. A promo is just a Stripe
// Coupon; two metadata keys drive checkout behavior (both editable on a coupon
// without recreating it, so an admin backoffice or the Stripe dashboard can
// toggle them):
//
//   metadata.auto_apply = "true"   → applied for the buyer when checkout opens
//                                     (else it only lands if they type its code)
//   metadata.plan = "monthly"|"yearly" (omitted = both) → plan targeting
//
// `coupon.valid` already accounts for redeem_by + max_redemptions, so expiry
// and limits are enforced by Stripe.
//
// Everything reaches a Session BY CODE now, auto-apply included. A Checkout
// Session takes either a server-set `discounts` array or `allow_promotion_codes`
// — Stripe rejects both on one Session ("You may only specify one of these
// parameters") and holds one discount at a time — and we need the buyer to be
// able to type a code, so `allow_promotion_codes` wins and the house sale is
// applied client-side with the same applyPromotionCode call. Practical upshot:
// an auto-apply coupon with no promotion code is unreachable at checkout, which
// is why the back office now requires one.

import type Stripe from 'stripe'
import type { Plan } from './pricing.js'

// The default charge currency. Checkout now passes an explicit currency (§7 #4
// per-currency floors replaced Adaptive Pricing), so callers on a non-USD path
// pass that currency through; USD-only callers (gift, retention) keep the
// default. A fixed (amount_off) coupon only applies when its currency matches
// the charge currency — Stripe rejects a mismatched-currency coupon on the
// subscription otherwise.
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
export function discountCents(
  c: CouponLike,
  baseCents: number,
  chargeCurrency: string = CHARGE_CURRENCY,
): number {
  if (c.percent_off != null) return Math.round((baseCents * c.percent_off) / 100)
  if (c.amount_off != null && c.currency === chargeCurrency) {
    return Math.min(baseCents, c.amount_off)
  }
  return 0
}

// Best auto-applicable coupon for a plan, ranked by actual discount on the
// given base price — so percentage and fixed coupons compare correctly. Null
// if nothing applies. Pass plan=null to ignore plan targeting entirely (any
// auto-apply coupon qualifies) — used by the gift flow, which has no plan.
export function pickBestCoupon<T extends CouponLike>(
  coupons: T[],
  plan: Plan | null,
  baseCents: number,
  chargeCurrency: string = CHARGE_CURRENCY,
): T | null {
  let best: T | null = null
  let bestDiscount = 0
  for (const c of coupons) {
    if (!isAutoApply(c) || (plan !== null && !appliesToPlan(c, plan))) continue
    const d = discountCents(c, baseCents, chargeCurrency)
    if (d > bestDiscount) {
      best = c
      bestDiscount = d
    }
  }
  return best
}

// Minimal structural subset of Stripe.PromotionCode, same rationale as
// CouponLike above.
export type PromotionCodeLike = {
  code: string
  active: boolean
  // Set when the code is reserved for one customer.
  customer: unknown
  promotion: { coupon: string | { id: string } | null } | null
}

// couponId → the code a buyer can actually redeem. Inactive codes are skipped
// (Stripe would reject them), and so are customer-restricted ones: nobody else
// can redeem them, and the endpoint that serves this map is public.
export function redeemableCodeByCoupon(
  codes: PromotionCodeLike[],
): Map<string, string> {
  const byCoupon = new Map<string, string>()
  for (const pc of codes) {
    if (!pc.active || pc.customer) continue
    const c = pc.promotion?.coupon
    const couponId = typeof c === 'string' ? c : c?.id
    if (couponId && !byCoupon.has(couponId)) byCoupon.set(couponId, pc.code)
  }
  return byCoupon
}

// The house promo to apply for the buyer: the best auto-apply coupon that has a
// code to apply it with. It IS pickBestCoupon — over the coupons that carry a
// redeemable code — so ranking stays in one place.
export function pickAutoApplyPromo<T extends CouponLike>(
  coupons: T[],
  codes: PromotionCodeLike[],
  plan: Plan | null,
  baseCents: number,
  chargeCurrency: string = CHARGE_CURRENCY,
): { coupon: T; code: string } | null {
  const codeFor = redeemableCodeByCoupon(codes)
  const best = pickBestCoupon(
    coupons.filter((c) => codeFor.has(c.id)),
    plan,
    baseCents,
    chargeCurrency,
  )
  if (!best) return null
  const code = codeFor.get(best.id)
  return code ? { coupon: best, code } : null
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

// Every promotion code (paginated), so a coupon can be matched to its code past
// the 100-per-page limit. Mirrors listActiveCoupons. Pass `active: true` for the
// codes a buyer could still redeem; the back office lists all of them so an
// exhausted code still shows next to its coupon.
export async function listPromotionCodes(
  stripe: Stripe,
  params: { active?: boolean } = {},
): Promise<Stripe.PromotionCode[]> {
  const all: Stripe.PromotionCode[] = []
  let startingAfter: string | undefined
  for (let i = 0; i < 20; i++) {
    const page = await stripe.promotionCodes.list({
      ...params,
      limit: 100,
      starting_after: startingAfter,
    })
    all.push(...page.data)
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }
  return all
}
