// Back-office promo creation. A "promo" is a Stripe Coupon (the discount) plus
// a Promotion Code (the human-readable string, e.g. SPRING60). The limits that
// gate a promo — redeem_by, max_redemptions — live on the *coupon*, where
// `coupon.valid` enforces them; the code is how a promo reaches a Session.
//
// The code is optional only for a promo nobody applies at checkout (a retention
// offer, attached to a subscription by coupon id). An auto-apply promo needs
// one: checkout carries `allow_promotion_codes` rather than a server-set
// `discounts` array — see server/lib/stripe-promos.ts — so the house sale is
// applied with the buyer's own applyPromotionCode call, by code.
//
// `buildPromo` is pure (no Stripe calls), so the validation is unit-tested with
// plain objects; the route does the I/O.

import type Stripe from 'stripe'
import type { Promo } from '../../shared/promo.js'
import { isCouponSlot } from '../../shared/retention.js'

type BuiltPromo = {
  coupon: Stripe.CouponCreateParams
  // Promotion-code string to create against the new coupon, or null for none.
  code: string | null
  // Restrictions that live on the CODE rather than the coupon. Stripe checks
  // them at redemption, which is what makes them per-buyer — the coupon's own
  // max_redemptions is global. Empty when nothing was asked for.
  restrictions: CodeRestrictions
}

type CodeRestrictions = {
  maxRedemptions?: number
  // Unix seconds.
  expiresAt?: number
  firstTimeTransaction?: boolean
  // The minimum basket in USD minor units. The route fans it out across every
  // supported currency (see minimumsByCurrency) before it reaches Stripe.
  minimumAmountCents?: number
}

// Stripe upper-cases promo codes; keep the input to a safe, shareable subset.
const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/

// The catalog's source currency: what a fixed `amount_off` is denominated in,
// and the top-level currency of a code's minimum spend.
const BASE_CURRENCY = 'usd'

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
    coupon.currency = BASE_CURRENCY // matches the checkout's source currency
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

  // Metadata drives behavior: auto_apply (checkout) + optional plan targeting,
  // plus retention_offer, which flags the coupon for the cancel save flow
  // (server/lib/retention.ts). A retention coupon is offered, never auto-applied
  // at checkout, so the two flags are independent.
  const metadata: Record<string, string> = { auto_apply: String(r.autoApply === true) }
  const isRetention = r.retentionOffer === true
  if (isRetention) metadata.retention_offer = 'true'

  // offer_kind names WHICH save in the cancel flow a retention coupon fills.
  // Required for a retention coupon — an untagged one would be flagged but never
  // reachable by the deriver, i.e. silently inert. Meaningless on a checkout
  // promo, so reject it there rather than write a tag nothing reads.
  if (r.offerKind != null && r.offerKind !== '') {
    if (!isRetention) {
      return { ok: false, error: 'Only a retention offer can target a cancel-flow save.' }
    }
    if (!isCouponSlot(r.offerKind)) {
      return { ok: false, error: 'Unknown cancel-flow save slot.' }
    }
    metadata.offer_kind = r.offerKind
  } else if (isRetention) {
    return { ok: false, error: 'Choose where this retention offer appears.' }
  }

  // A save is a temporary discount, never a permanent price cut: a forever
  // coupon here would silently discount the member for life.
  if (isRetention && coupon.duration === 'forever') {
    return { ok: false, error: 'A retention offer must run for a set number of months.' }
  }

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

  // Human-readable code. Required for an auto-apply promo, which checkout can
  // only reach by code — without one it would be created inert, discounting
  // nobody and silently.
  let code: string | null = null
  if (r.code != null && r.code !== '') {
    if (typeof r.code !== 'string' || !CODE_RE.test(r.code.trim())) {
      return { ok: false, error: 'Code must be 2–40 characters: letters, numbers, _ or -.' }
    }
    code = r.code.trim().toUpperCase()
  }
  if (!code && r.autoApply === true) {
    return { ok: false, error: 'An auto-apply promo needs a code — checkout applies it by code.' }
  }

  // Per-buyer limits. These belong to the code, so they need one; a promo with
  // no code has nothing to hang them on.
  const restrictions: CodeRestrictions = {}
  if (r.firstTimeOnly === true) restrictions.firstTimeTransaction = true
  if (r.codeMaxRedemptions != null && r.codeMaxRedemptions !== '') {
    const n = Number(r.codeMaxRedemptions)
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'Redemptions per code must be a positive whole number.' }
    }
    // Stripe rejects this outright; saying so here avoids a create-then-roll-back.
    if (coupon.max_redemptions != null && n > coupon.max_redemptions) {
      return {
        ok: false,
        error: "A code can't be redeemed more times than the promo itself allows.",
      }
    }
    restrictions.maxRedemptions = n
  }
  if (r.codeExpiresAt != null && r.codeExpiresAt !== '') {
    if (typeof r.codeExpiresAt !== 'string') {
      return { ok: false, error: 'Code expiry must be a date.' }
    }
    const ms = Date.parse(r.codeExpiresAt)
    if (Number.isNaN(ms)) return { ok: false, error: 'Code expiry is not a valid date.' }
    if (ms <= Date.now()) return { ok: false, error: 'Code expiry must be in the future.' }
    const seconds = Math.floor(ms / 1000)
    if (coupon.redeem_by != null && seconds > coupon.redeem_by) {
      return { ok: false, error: "A code can't outlive the promo's own redeem-by date." }
    }
    restrictions.expiresAt = seconds
  }
  if (r.minimumAmountCents != null && r.minimumAmountCents !== '') {
    const n = Number(r.minimumAmountCents)
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'Minimum spend (in cents) must be a positive whole number.' }
    }
    restrictions.minimumAmountCents = n
  }
  if (!code && Object.keys(restrictions).length > 0) {
    return { ok: false, error: 'Per-buyer limits need a code — they are checked when it is redeemed.' }
  }

  return { ok: true, value: { coupon, code, restrictions } }
}

// A minimum spend set in USD alone makes the code unredeemable in every other
// currency — Stripe requires the charge currency to be among the code's own
// ("The supported currencies of your promotion code (usd) must include the
// currency of the object"). So the USD figure is scaled into all of them using
// the catalog's per-currency floors as the ratio: the same purchasing-power
// table the whole site prices from, rather than an FX rate we'd have to invent
// and keep fresh. A minimum worth "about an annual membership" stays that
// everywhere.
export function minimumsByCurrency(
  usdCents: number,
  floors: Record<string, number>,
): Record<string, { minimum_amount: number }> {
  const usdFloor = floors.usd
  const out: Record<string, { minimum_amount: number }> = {}
  for (const [currency, floor] of Object.entries(floors)) {
    // USD is carried by minimum_amount/minimum_amount_currency and added to the
    // options by Stripe itself — passing it here is an error ("You are
    // specifying a currency option that matches the top-level currency").
    if (currency === BASE_CURRENCY) continue
    const scaled = usdFloor > 0 ? Math.round((usdCents * floor) / usdFloor) : usdCents
    // Stripe rejects a zero minimum; a rounded-down tiny one means "no floor"
    // anyway, so clamp rather than drop the currency (dropping it would make
    // the code unredeemable there).
    out[currency] = { minimum_amount: Math.max(1, scaled) }
  }
  return out
}

// Flattens a coupon (+ its promotion code) into the shared Promo view —
// surfaces the metadata flags, the code's own per-buyer restrictions, and
// normalizes both dates to ISO.
export function serializeCoupon(c: Stripe.Coupon, pc: Stripe.PromotionCode | null): Promo {
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
    retentionOffer: c.metadata?.retention_offer?.toLowerCase() === 'true',
    offerKind: c.metadata?.offer_kind ?? null,
    plan: c.metadata?.plan ?? null,
    maxRedemptions: c.max_redemptions ?? null,
    timesRedeemed: c.times_redeemed ?? 0,
    redeemBy: c.redeem_by ? new Date(c.redeem_by * 1000).toISOString() : null,
    code: pc?.code ?? null,
    codeMaxRedemptions: pc?.max_redemptions ?? null,
    codeTimesRedeemed: pc ? pc.times_redeemed : null,
    codeExpiresAt: pc?.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
    firstTimeOnly: pc?.restrictions.first_time_transaction === true,
    minimumAmountCents: pc?.restrictions.minimum_amount ?? null,
  }
}
