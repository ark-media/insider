// Back-office promo creation. A "promo" is a Stripe Coupon (the discount) plus
// an optional Promotion Code (the human-readable string, e.g. SPRING60). The
// existing checkout auto-applies the best coupon flagged `metadata.auto_apply`
// for the plan (server/lib/stripe-promos.ts), so the limits that gate a promo
// — redeem_by, max_redemptions — live on the *coupon*, where `coupon.valid`
// enforces them. The promotion code is a label/record on top.
//
// `buildPromo` is pure (no Stripe calls), so the validation is unit-tested with
// plain objects; the route does the I/O.

import type Stripe from 'stripe'
import type { Promo } from '../../shared/promo.js'

export type BuiltPromo = {
  coupon: Stripe.CouponCreateParams
  // Promotion-code string to create against the new coupon, or null for none.
  code: string | null
}

// Stripe upper-cases promo codes; keep the input to a safe, shareable subset.
const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/

export type BuildResult =
  | { ok: true; value: BuiltPromo }
  | { ok: false; error: string }

export function buildPromo(raw: unknown): BuildResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const r = raw as Record<string, unknown>
  const coupon: Stripe.CouponCreateParams = { duration: 'once' }

  // Discount: percent OR fixed USD amount.
  if (r.discountType === 'percent') {
    const p = Number(r.percentOff)
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      return { ok: false, error: 'Percent off must be between 0 and 100.' }
    }
    coupon.percent_off = p
  } else if (r.discountType === 'amount') {
    const a = Number(r.amountOffCents)
    if (!Number.isInteger(a) || a <= 0) {
      return { ok: false, error: 'Amount off (in cents) must be a positive whole number.' }
    }
    coupon.amount_off = a
    coupon.currency = 'usd' // matches the checkout's source currency
  } else {
    return { ok: false, error: "discountType must be 'percent' or 'amount'." }
  }

  // Duration across billing periods.
  if (r.duration === 'once' || r.duration === 'forever' || r.duration === 'repeating') {
    coupon.duration = r.duration
    if (r.duration === 'repeating') {
      const m = Number(r.durationInMonths)
      if (!Number.isInteger(m) || m < 1) {
        return { ok: false, error: 'Duration in months is required for a repeating promo.' }
      }
      coupon.duration_in_months = m
    }
  } else {
    return { ok: false, error: "duration must be 'once', 'forever', or 'repeating'." }
  }

  // Optional display name.
  if (r.name != null) {
    if (typeof r.name !== 'string') return { ok: false, error: 'Name must be a string.' }
    const name = r.name.trim()
    if (name) coupon.name = name.slice(0, 200)
  }

  // Metadata drives checkout behavior: auto_apply + optional plan targeting.
  const metadata: Record<string, string> = { auto_apply: String(r.autoApply === true) }
  if (r.plan === 'monthly' || r.plan === 'yearly') {
    metadata.plan = r.plan
  } else if (r.plan != null && r.plan !== '' && r.plan !== 'both') {
    return { ok: false, error: "plan must be 'monthly', 'yearly', or empty for both." }
  }
  coupon.metadata = metadata

  // Optional usage limits — enforced by coupon.valid.
  if (r.maxRedemptions != null && r.maxRedemptions !== '') {
    const mr = Number(r.maxRedemptions)
    if (!Number.isInteger(mr) || mr < 1) {
      return { ok: false, error: 'Max redemptions must be a positive whole number.' }
    }
    coupon.max_redemptions = mr
  }
  if (r.redeemBy != null && r.redeemBy !== '') {
    if (typeof r.redeemBy !== 'string') return { ok: false, error: 'Redeem-by must be a date.' }
    const ms = Date.parse(r.redeemBy)
    if (Number.isNaN(ms)) return { ok: false, error: 'Redeem-by is not a valid date.' }
    if (ms <= Date.now()) return { ok: false, error: 'Redeem-by must be in the future.' }
    coupon.redeem_by = Math.floor(ms / 1000)
  }

  // Optional human-readable code.
  let code: string | null = null
  if (r.code != null && r.code !== '') {
    if (typeof r.code !== 'string' || !CODE_RE.test(r.code.trim())) {
      return { ok: false, error: 'Code must be 2–40 characters: letters, numbers, _ or -.' }
    }
    code = r.code.trim().toUpperCase()
  }

  return { ok: true, value: { coupon, code } }
}

// Flattens a coupon (+ its promotion-code label) into the shared Promo view —
// surfaces the metadata flags and normalizes redeem_by to ISO.
export function serializeCoupon(c: Stripe.Coupon, code: string | null): Promo {
  return {
    id: c.id,
    name: c.name ?? null,
    valid: c.valid,
    kind: c.percent_off != null ? 'percent' : 'amount',
    percentOff: c.percent_off ?? null,
    amountOffCents: c.amount_off ?? null,
    currency: c.currency ?? null,
    duration: c.duration,
    durationInMonths: c.duration_in_months ?? null,
    autoApply: c.metadata?.auto_apply?.toLowerCase() === 'true',
    plan: c.metadata?.plan ?? null,
    maxRedemptions: c.max_redemptions ?? null,
    timesRedeemed: c.times_redeemed ?? 0,
    redeemBy: c.redeem_by ? new Date(c.redeem_by * 1000).toISOString() : null,
    code,
  }
}

// All promotion codes (paginated), so every coupon can be matched to its code
// label even past the 100-per-page limit. Mirrors listActiveCoupons.
export async function listAllPromotionCodes(
  stripe: Stripe,
): Promise<Stripe.PromotionCode[]> {
  const all: Stripe.PromotionCode[] = []
  let startingAfter: string | undefined
  for (let i = 0; i < 20; i++) {
    const page = await stripe.promotionCodes.list({ limit: 100, starting_after: startingAfter })
    all.push(...page.data)
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }
  return all
}
