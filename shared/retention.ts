// API view of a retention save offer. Originally this was just "keep your
// discount" (a single Stripe coupon). The tier-aware cancel flows generalize it
// so a step can describe a *plan switch* (monthly↔annual) or a *coupon* —
// bounded (duration_in_months) or perpetual (duration: forever) — not only one
// coupon. Shared by the server deriver and the client offer step. Amounts are
// USD cents (our source currency).

// What kind of save this offer represents. Drives both the copy the client
// renders and the terminal action it takes when accepted:
//   annual_switch        monthly → annual plan switch (change-tier; usually no coupon)
//   monthly_switch       annual → monthly plan switch (change-tier; perpetual coupon holds the rate)
//   supporter_coupon     Ark+ monthly bounded supporter rate (attach coupon)
//   affordability_coupon Circle bounded affordability rate (attach coupon)
//   circle_free_months   annual-bundle debundle: N months of Circle free (attach coupon)
//   perpetual_discount   a duration: forever coupon (attach coupon)
export type OfferKind =
  | 'annual_switch'
  | 'monthly_switch'
  | 'supporter_coupon'
  | 'affordability_coupon'
  | 'circle_free_months'
  | 'perpetual_discount'

// Plan-switch kinds change the billing cadence (via change-tier) rather than
// attaching a coupon by themselves; they are never rate-limited (Decision #6).
const PLAN_SWITCH_KINDS: ReadonlySet<OfferKind> = new Set(['annual_switch', 'monthly_switch'])

export function isPlanSwitchKind(kind: OfferKind): boolean {
  return PLAN_SWITCH_KINDS.has(kind)
}

// The intent that opened the save flow, resolving which offers to derive.
//   cancel-ark-plus          Flow A — cancel a standalone Ark+ sub
//   cancel-circle            Flow B — cancel a standalone Community sub
//   debundle-remove-ark-plus Flow C — bundle → keep Community (runs the Ark+ save)
//   debundle-remove-circle   Flow D — bundle → keep Ark+ (annual gets 3mo free)
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

export type RetentionOffer = {
  // The save kind — see OfferKind. Determines copy + accept action client-side.
  kind: OfferKind
  // The Stripe coupon to attach, when the offer carries one. A pure plan switch
  // (e.g. bare annual_switch) has no coupon, so this is null.
  couponId: string | null
  label: string | null
  percentOff: number | null
  amountOff: number | null
  // Bounded coupons only (a repeating coupon's duration_in_months); null for a
  // once-off or perpetual coupon, or a couponless plan switch.
  durationMonths: number | null
  // True when the coupon is duration: forever (perpetual). Mutually exclusive
  // with a non-null durationMonths.
  forever: boolean
  // Plan-switch offers only (annual_switch / monthly_switch): the plan being
  // switched to plus the resolved list prices (USD cents) of the current and
  // target plans, so the client can render concrete savings without re-fetching
  // the catalog. Absent (undefined) for pure coupon offers.
  targetPlan?: 'monthly' | 'yearly'
  targetPriceCents?: number
  currentPriceCents?: number
}
