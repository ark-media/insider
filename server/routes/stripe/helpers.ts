import type Stripe from 'stripe'
import { getDb } from '../../lib/db.js'
import { clearMembershipPending } from '../../lib/membership.js'
import {
  formatMinorUnits,
  type Plan,
  type PricedTier,
} from '../../lib/pricing.js'
import type { Env } from '../../lib/route.js'

// Stripe's hard limit is 256; we cap a touch lower to leave room.
export const MAX_NAME_LEN = 250

// Find a Customer for this email or create one. Checkout has historically
// created a Customer per Session, so one email can map to several customers
// (churn-then-resubscribe). Prefer one without an active subscription so a
// new sub doesn't end up on a customer that already has one — bounded scan
// keeps the API cost modest even with many matches.
export async function findOrCreateSubscriber(
  stripe: Stripe,
  opts: { email: string; name?: string },
): Promise<Stripe.Customer> {
  const { email, name } = opts
  const list = await stripe.customers.list({ email, limit: 100 })
  if (list.data.length === 0) {
    return stripe.customers.create({ email, name })
  }
  if (list.data.length === 1) return list.data[0]
  // Multiple matches — try to pick a clean one. Cap the scan so a pathological
  // case (many duplicates) doesn't fan out to dozens of Stripe calls.
  for (const c of list.data.slice(0, 10)) {
    const subs = await stripe.subscriptions.list({
      customer: c.id,
      status: 'active',
      limit: 1,
    })
    if (subs.data.length === 0) return c
  }
  return list.data[0]
}

// Statuses that count as a live membership for the single-active-subscription
// guard (§8 risk 1). `incomplete`/`incomplete_expired` are excluded: those are a
// buyer's own not-yet-paid attempt, which must not block them from retrying.
const LIVE_SUB_STATUSES = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
  'unpaid',
])

// Find this email's live subscription across all its Stripe customers, or null.
// Checkout mints a Customer per session, so one email can map to several
// (churn-then-resubscribe); scan them all concurrently rather than assuming one.
// Matches any LIVE status (active/trialing/past_due/unpaid), not just 'active'
// (task 14): a delinquent member in dunning is still entitled and must be able
// to cancel, reactivate, or switch plans from the account UI. The single-active-
// subscription guard treats the same set as live, so a second checkout can't
// mint a second sub whose webhook overwrites the one-row membership and runs
// scDelete on the still-paid feed.
export async function findLiveSubscription(
  stripe: Stripe,
  email: string,
): Promise<Stripe.Subscription | null> {
  const customers = await stripe.customers.list({ email, limit: 100 })
  const subLists = await Promise.all(
    customers.data.map((customer) =>
      stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 }),
    ),
  )
  for (const subs of subLists) {
    for (const sub of subs.data) {
      if (LIVE_SUB_STATUSES.has(sub.status)) return sub
    }
  }
  return null
}

// A PricedTier from untrusted input, defaulting to Ark+ (the only tier the
// pre-task-13 client offers). `free` is not sellable.
export function coerceTier(raw: unknown): PricedTier {
  return raw === 'circle' || raw === 'bundle' || raw === 'ark-plus' ? raw : 'ark-plus'
}

// Upper sanity bound on a PWYC custom amount, in the floor's own minor units. A
// flat cap can't serve 40 currencies — a high-denomination floor (e.g. IDR
// 12,900,000) would exceed any USD-scaled constant and reject every valid
// amount. Scale off the floor, but never below the original ~$10k USD cap.
function pwycMaxAmount(floor: number): number {
  return Math.max(1_000_000, floor * 1000)
}

// Validate a pay-what-you-can custom amount against the tier/plan floor. No
// custom amount (or a non-numeric one) charges the floor; a custom amount must
// sit within [floor, pwycMaxAmount]. Returns the amount to charge, or a
// client-facing error string. Shared by create-checkout-session and change-tier.
export function validatePwycAmount(
  customAmountCents: unknown,
  floor: number,
  currency: string,
): { amountCents: number } | { error: string } {
  if (
    typeof customAmountCents === 'number' &&
    Number.isFinite(customAmountCents)
  ) {
    if (customAmountCents < floor) {
      return { error: `Amount must be at least ${formatMinorUnits(floor, currency)}.` }
    }
    if (customAmountCents > pwycMaxAmount(floor)) {
      return { error: 'Custom amount too large.' }
    }
    return { amountCents: Math.round(customAmountCents) }
  }
  return { amountCents: floor }
}

// The plan a subscription bills on, from its recurring interval, so the cancel
// save flow can offer a plan-targeted retention coupon. Null when the interval
// isn't month/year (or the sub has no items) — the picker then offers only
// untargeted coupons rather than guessing.
export function planFromSubscription(sub: Stripe.Subscription): Plan | null {
  // `items` itself optional-chained, not just `data[0]`: the doc above promises
  // null for an itemless sub, but `sub.items.data` threw outright when `items`
  // was absent — which a `customer.subscription.deleted` payload can be. Every
  // caller sits on a webhook or a request path where a throw becomes a 5xx, so
  // this matches the documented contract rather than relying on callers to
  // never pass a partial subscription.
  const interval = sub.items?.data?.[0]?.price?.recurring?.interval
  if (interval === 'month') return 'monthly'
  if (interval === 'year') return 'yearly'
  return null
}

// The subscription's current-period-end as an ISO string, or null when the sub
// has no items / no finite timestamp. Used for the renewal/access date in the
// cancel, reactivate, and accept-offer responses — all read it *after* a Stripe
// write has already succeeded, so an itemless sub must degrade to null rather
// than throw a 500 that strands an action that already happened.
// Stripe timestamps are unix seconds; our API/DB speak ISO strings. Null in
// (or a non-finite value from a malformed payload) → null out, never "Invalid
// Date".
export function tsToIso(ts: number | null | undefined): string | null {
  return ts != null && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null
}

// The Stripe customer id off a subscription, whether the field is expanded to
// an object or left as the bare id string.
export function customerIdOf(sub: Stripe.Subscription): string {
  return typeof sub.customer === 'string' ? sub.customer : sub.customer.id
}

export function periodEndIso(sub: Stripe.Subscription): string | null {
  return tsToIso(sub.items.data[0]?.current_period_end)
}

// The card the next bill will actually be charged to, for the account page's
// plan card. Stripe charges the subscription's own default payment method when
// it names one, and otherwise falls back to the customer's invoice default —
// so this reads them in that order rather than assuming either.
//
// Entirely best-effort. This is one line of reassurance on a page whose real
// job is elsewhere, so any hiccup (a deleted method, a non-card method, an
// expand that doesn't come back) drops the line rather than failing the
// request that carries the member's renewal date.
export type CardOnFile = {
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

export async function readCardOnFile(
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<CardOnFile | null> {
  try {
    const fromSub = sub.default_payment_method
    let pm: Stripe.PaymentMethod | null =
      fromSub && typeof fromSub !== 'string' ? fromSub : null
    let pmId = typeof fromSub === 'string' ? fromSub : null

    if (!pm && !pmId) {
      // No method on the subscription — ask the customer for its invoice
      // default. `sub.customer` is usually the bare id here, so retrieve it.
      const customer =
        typeof sub.customer === 'string'
          ? await stripe.customers.retrieve(sub.customer)
          : sub.customer
      // A deleted customer carries no settings — nothing to read.
      if (!customer || customer.deleted) return null
      const invoiceDefault = customer.invoice_settings?.default_payment_method
      if (invoiceDefault && typeof invoiceDefault !== 'string') pm = invoiceDefault
      else if (typeof invoiceDefault === 'string') pmId = invoiceDefault
    }

    if (!pm && pmId) pm = await stripe.paymentMethods.retrieve(pmId)
    const card = pm?.card
    if (!card) return null
    return {
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
    }
  } catch {
    return null
  }
}

// The plan a subscription is *scheduled* to move to at period end, or null when
// nothing is scheduled (or it can't be read). change-tier books a cadence switch
// as a future schedule phase, so between that call and period end the live sub
// still reports the OLD interval — `planFromSubscription` alone can't tell you a
// switch is coming. Soft-fails to null: callers treat "unknown" as "not
// switched", which is the safe direction for an authorization check.
export async function scheduledPlanOf(
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<Plan | null> {
  const scheduleId = scheduleIdOf(sub)
  if (!scheduleId) return null
  try {
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
    const lastPhase = schedule.phases?.[schedule.phases.length - 1]
    const price = lastPhase?.items?.[0]?.price
    if (!price) return null
    const resolved =
      typeof price === 'string' ? await stripe.prices.retrieve(price) : price
    if ('deleted' in resolved && resolved.deleted) return null
    const interval = resolved.recurring?.interval
    if (interval === 'month') return 'monthly'
    if (interval === 'year') return 'yearly'
    return null
  } catch (err) {
    console.error('[stripe] scheduled plan lookup failed:', err)
    return null
  }
}

// The schedule id attached to a sub, or null. A subscription with a pending
// period-end change (task 14) is schedule-managed; several plain
// subscriptions.update calls (cancel_at_period_end, discounts) are REJECTED by
// Stripe while a schedule is attached (§6 point 2), so the billing routes must
// detach it first.
export function scheduleIdOf(sub: Stripe.Subscription): string | null {
  if (!sub.schedule) return null
  return typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id
}

// Release any attached subscription schedule so a following plain
// subscriptions.update succeeds. Releasing detaches the schedule and leaves the
// subscription on its current phase — exactly what Cancel / Reactivate /
// retention want before they mutate the sub. Also clears the Neon pending-change
// columns for the customer. Idempotent: a no-schedule sub is a no-op.
export async function releaseScheduleIfAny(
  stripe: Stripe,
  sub: Stripe.Subscription,
  env: Env,
): Promise<void> {
  const scheduleId = scheduleIdOf(sub)
  if (!scheduleId) return
  await stripe.subscriptionSchedules.release(scheduleId)
  const customerId = customerIdOf(sub)
  if (env.DATABASE_URL) {
    try {
      await clearMembershipPending(getDb(env), customerId)
    } catch (err) {
      console.error('[stripe] clear pending after schedule release failed:', err)
    }
  }
}

// Whether a tier/amount change applies immediately (prorated in place) or at
// period end (via a schedule). Rules (§6 table): gaining an entitlement →
// immediate; losing one → period end; same entitlements → immediate iff the new
// amount is >= the old (a raise, or monthly→yearly), else period end.
export function changeIsImmediate(
  prev: { arkPlus: boolean; circle: boolean },
  next: { arkPlus: boolean; circle: boolean },
  prevAmountCents: number | null,
  nextAmountCents: number,
): boolean {
  const gains = (next.arkPlus && !prev.arkPlus) || (next.circle && !prev.circle)
  const loses = (prev.arkPlus && !next.arkPlus) || (prev.circle && !next.circle)
  if (gains && !loses) return true
  if (loses) return false
  // Same entitlement set — a PWYC raise / monthly→yearly is immediate.
  return prevAmountCents == null || nextAmountCents >= prevAmountCents
}
