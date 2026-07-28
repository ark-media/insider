// API view of a retention save offer. Originally this was just "keep your
// discount" (a single Stripe coupon). The tier-aware cancel flows generalize it
// so a step can describe a *plan switch* (monthly↔annual) or a *coupon* — not
// only one coupon. Retention discounts are always time-bounded (a fixed number
// of months); a save is never a permanent price cut. Shared by the server
// deriver and the client offer step. Amounts are USD cents (our source
// currency).

// What kind of save this offer represents. Drives both the copy the client
// renders and the terminal action it takes when accepted:
//   annual_switch        monthly → annual plan switch (change-tier; usually no coupon)
//   monthly_switch       annual → monthly plan switch (change-tier; no coupon)
//   supporter_coupon     Ark+ monthly bounded supporter rate (attach coupon)
//   affordability_coupon Circle bounded affordability rate (attach coupon)
export type OfferKind =
  | 'annual_switch'
  | 'monthly_switch'
  | 'supporter_coupon'
  | 'affordability_coupon'

// Every slot an admin can tag a coupon with (metadata.offer_kind). Two back a
// member-facing save card; the third is the debundle intro rate, which is applied
// automatically rather than offered. One source for the admin form's options and
// the server's validation. Plan-switch kinds aren't here: they're derived from
// the catalog, not configured.
export const COUPON_SLOTS = [
  'supporter_coupon',
  'affordability_coupon',
  'debundle_intro',
] as const

export type CouponSlot = (typeof COUPON_SLOTS)[number]

// How each slot reads in the back office — where the member sees it.
export const COUPON_SLOT_LABEL: Record<CouponSlot, string> = {
  supporter_coupon: 'Ark+ monthly — “keep your benefits” discount',
  affordability_coupon: 'Community — “keep your benefits” discount',
  debundle_intro: 'Debundle — intro rate on the product you keep',
}

export function isCouponSlot(v: unknown): v is CouponSlot {
  return typeof v === 'string' && (COUPON_SLOTS as readonly string[]).includes(v)
}

// The slot holding the bounded discount a debundling member lands on. Applied by
// change-tier (never rendered as a card), so it is deliberately NOT an OfferKind.
export const DEBUNDLE_INTRO_SLOT = 'debundle_intro'

// The subset of slots that back a save card, i.e. the coupon-valued OfferKinds.
export const COUPON_OFFER_KINDS = ['supporter_coupon', 'affordability_coupon'] as const

export type CouponOfferKind = (typeof COUPON_OFFER_KINDS)[number]

export function isCouponOfferKind(v: unknown): v is CouponOfferKind {
  return typeof v === 'string' && (COUPON_OFFER_KINDS as readonly string[]).includes(v)
}

// Plan-switch kinds change the billing cadence (via change-tier) rather than
// attaching a coupon by themselves; they are never rate-limited (Decision #6).
const PLAN_SWITCH_KINDS: ReadonlySet<OfferKind> = new Set(['annual_switch', 'monthly_switch'])

export function isPlanSwitchKind(kind: OfferKind): boolean {
  return PLAN_SWITCH_KINDS.has(kind)
}

// The intent that opened the save flow, resolving which offers to derive.
//   cancel-ark-plus          Flow A — cancel a standalone Ark+ sub
//   cancel-circle            Flow B — cancel a standalone Community sub
//   debundle-remove-ark-plus Flow C — bundle → keep Community (no card; intro rate)
//   debundle-remove-circle   Flow D — bundle → keep Ark+ (no card; intro rate)
// Neither debundle carries a save card: the offer is priced into the exit (the
// kept product lands on a bounded intro rate), so the flow goes straight to the
// confirm screen. The intents remain distinct because each resolves a different
// kept-product price preview.
export type SaveIntent =
  | 'cancel-ark-plus'
  | 'cancel-circle'
  | 'debundle-remove-ark-plus'
  | 'debundle-remove-circle'

const SAVE_INTENTS: ReadonlySet<string> = new Set([
  'cancel-ark-plus',
  'cancel-circle',
  'debundle-remove-ark-plus',
  'debundle-remove-circle',
])

export function isSaveIntent(v: unknown): v is SaveIntent {
  return typeof v === 'string' && SAVE_INTENTS.has(v)
}

// Which intents a given tier can legitimately open. The intent arrives in the
// request body, so `isSaveIntent` only proves it is a well-formed value — not
// that this member is entitled to that flow. Without a tier check the caller
// chooses which offer set the server derives, and can pull a coupon scoped to a
// product they don't hold onto the subscription they do.
const INTENTS_BY_TIER: Record<string, readonly SaveIntent[]> = {
  'ark-plus': ['cancel-ark-plus'],
  circle: ['cancel-circle'],
  bundle: ['debundle-remove-ark-plus', 'debundle-remove-circle'],
  free: [],
}

export function intentAllowedForTier(intent: SaveIntent, tier: string): boolean {
  return (INTENTS_BY_TIER[tier] ?? []).includes(intent)
}

export type RetentionOffer = {
  // The save kind — see OfferKind. Determines copy + accept action client-side.
  kind: OfferKind
  // The Stripe coupon to attach, when the offer carries one. A pure plan switch
  // (e.g. bare annual_switch) has no coupon, so this is null.
  couponId: string | null
  label: string | null
  percentOff: number | null
  amountOff: number | null
  // How many months the discount runs (a repeating coupon's duration_in_months);
  // null for a once-off coupon or a couponless plan switch.
  durationMonths: number | null
  // Plan-switch offers only (annual_switch / monthly_switch): the plan being
  // switched to plus the resolved list price (USD cents) of the target plan, so
  // the client can render concrete savings without re-fetching the catalog.
  targetPlan?: 'monthly' | 'yearly'
  targetPriceCents?: number
  // The list price (USD cents) the offer is measured against: the current plan's
  // price for a plan switch, and the price the coupon discounts for a coupon
  // offer — the struck-through figure in the design's "$8 $6/month". Absent when
  // the catalog price couldn't be resolved, in which case the card omits it.
  currentPriceCents?: number
}

// What one product costs once a bundle is split, for the "keep any services?"
// selector and the debundle confirm screen. Two figures, because a debundle
// lands on a bounded intro rate before settling at the catalog price:
//   priceCents  the standalone catalog price — the ongoing rate, and the
//               struck-through figure in "$8.00 $6.50/month"
//   introCents  what they actually pay for `introMonths`, when a debundle_intro
//               coupon is configured. Null (with introMonths null) when none is,
//               in which case the debundle simply lands at priceCents.
// Both in USD cents. introCents is derived by applying the coupon to priceCents,
// so the quote always matches what Stripe will charge even if an admin retunes
// the coupon.
export type DebundlePrice = {
  tier: 'ark-plus' | 'circle' | 'bundle'
  plan: 'monthly' | 'yearly'
  priceCents: number
  introCents: number | null
  introMonths: number | null
}
