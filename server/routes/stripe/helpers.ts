import type Stripe from 'stripe'
import { getDb } from '../../lib/db.js'
import { listStripeCustomersByEmail } from '../../lib/entitlement-resolver.js'
import { clearMembershipPending } from '../../lib/membership.js'
import {
  formatMinorUnits,
  requiresWholeUnits,
  type Plan,
  type PricedTier,
} from '../../lib/pricing.js'
import { discountsSurvivingChange } from '../../lib/retention.js'
import type { Env } from '../../lib/route.js'

// Stripe's hard limit is 256; we cap a touch lower to leave room.
export const MAX_NAME_LEN = 250

// Find a Customer for this email or create one. Checkout has historically
// created a Customer per Session, so one email can map to several customers
// (churn-then-resubscribe). Prefer one without an active subscription so a
// new sub doesn't end up on a customer that already has one — bounded scan
// keeps the API cost modest even with many matches.
//
// `reuseExisting` is the caller's statement that the request is a durable login
// AS this email. Checkout takes the address from an unauthenticated form, and a
// Customer is not a neutral container: it carries a saved card, a balance (a
// credited gift lands there), a billing address and an invoice history. Attaching
// a stranger's Checkout Session to it hands them all of that on the strength of
// knowing an email address. So an unproven email always gets a fresh Customer;
// the duplicate is the cheap side of that trade, and the lookups here already
// cope with several Customers per email.
//
// The email is lowercased on the way in. Stripe's `customers.list({ email })` is
// an exact, case-sensitive match, so one address stored in two casings is two
// people to every guard built on that list — the single-active-subscription
// guard included.
export async function findOrCreateSubscriber(
  stripe: Stripe,
  opts: { email: string; name?: string; reuseExisting: boolean },
): Promise<Stripe.Customer> {
  const email = opts.email.trim().toLowerCase()
  const { name, reuseExisting } = opts
  if (!reuseExisting) return stripe.customers.create({ email, name })
  const matches = await listStripeCustomersByEmail(stripe, opts.email)
  if (matches.length === 0) {
    return stripe.customers.create({ email, name })
  }
  if (matches.length === 1) return matches[0]
  // Multiple matches — try to pick a clean one. Cap the scan so a pathological
  // case (many duplicates) doesn't fan out to dozens of Stripe calls.
  for (const c of matches.slice(0, 10)) {
    const subs = await stripe.subscriptions.list({
      customer: c.id,
      status: 'active',
      limit: 1,
    })
    if (subs.data.length === 0) return c
  }
  return matches[0]
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
//
// `withPaymentMethod` expands each subscription's default payment method, which
// is what lets readCardOnFile skip a serial paymentMethods.retrieve. It is
// OPT-IN rather than always-on: one of the twelve call sites reads the card, and
// the other eleven would otherwise pay for the expansion — on a list of up to
// 100 subscriptions per customer, across every customer sharing the email — to
// carry a field they never look at.
export async function findLiveSubscription(
  stripe: Stripe,
  email: string,
  { withPaymentMethod = false }: { withPaymentMethod?: boolean } = {},
): Promise<Stripe.Subscription | null> {
  const customers = await listStripeCustomersByEmail(stripe, email)
  const subLists = await Promise.all(
    customers.map((customer) =>
      stripe.subscriptions.list({
        customer: customer.id,
        status: 'all',
        limit: 100,
        ...(withPaymentMethod ? { expand: ['data.default_payment_method'] } : {}),
      }),
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
// custom amount charges the floor; a custom amount must be a whole number of
// minor units within [floor, pwycMaxAmount]. Returns the amount to charge, or a
// client-facing error string. Shared by create-checkout-session and change-tier.
//
// The floor is checked first, and a floor that isn't a positive integer is an
// error rather than a default. Both callers index a per-currency map for it, and
// every comparison against `undefined`/NaN is false — so a missing floor must
// not wave ANY amount through, one minor unit included, and with no custom
// amount it must not hand `undefined` on as the price.
export function validatePwycAmount(
  customAmountCents: unknown,
  floor: number,
  currency: string,
): { amountCents: number } | { error: string } {
  if (!Number.isInteger(floor) || floor <= 0) {
    console.error(`[stripe] no usable price floor for currency "${currency}":`, floor)
    return { error: 'This plan is not available in that currency.' }
  }
  if (customAmountCents === undefined || customAmountCents === null) {
    return { amountCents: floor }
  }
  // Present but not a whole number — a string, a float, NaN. Refuse rather than
  // quietly charge the floor: the buyer asked for something else, and rounding
  // 799.5 up to a floor of 800 is a decision nobody made.
  if (typeof customAmountCents !== 'number' || !Number.isInteger(customAmountCents)) {
    return { error: 'Amount must be a whole number.' }
  }
  if (customAmountCents < floor) {
    return { error: `Amount must be at least ${formatMinorUnits(floor, currency)}.` }
  }
  // HUF/TWD charge in hundredths but only in whole units. The browser rounds the
  // field this way already (src/lib/currency.ts); this is the check that holds
  // when the request didn't come from it. The floor itself is always accepted:
  // it is the catalog's own price, and a catalog provisioned before the
  // whole-unit rounding would otherwise make its own floor unbuyable.
  if (
    requiresWholeUnits(currency) &&
    customAmountCents !== floor &&
    customAmountCents % 100 !== 0
  ) {
    return { error: 'Amount must be a whole number.' }
  }
  if (customAmountCents > pwycMaxAmount(floor)) {
    return { error: 'Custom amount too large.' }
  }
  return { amountCents: customAmountCents }
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

// What an immediate change onto `priceId` takes off the card today: the full
// new price less credit for the unused part of the current one. Asked of
// Stripe with the same parameters change-tier sends, never re-derived here —
// including the retention coupons that change drops (`landing` is where it
// lands), which the preview would otherwise keep and quote too low.
// Null when it can't be quoted — callers then describe the charge without a
// figure.
export async function quoteChargeToday(
  stripe: Stripe,
  sub: Stripe.Subscription,
  priceId: string,
  landing: { tier: PricedTier; plan: Plan },
): Promise<number | null> {
  const itemId = sub.items.data[0]?.id
  if (!itemId) return null
  try {
    const discounts = await discountsSurvivingChange(stripe, sub, landing)
    const invoice = await stripe.invoices.createPreview({
      customer: customerIdOf(sub),
      subscription: sub.id,
      ...(discounts !== null ? { discounts } : {}),
      subscription_details: {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'always_invoice',
        billing_cycle_anchor: 'now',
      },
    })
    return invoice.amount_due
  } catch (err) {
    console.error('[stripe] charge-today quote failed:', err)
    return null
  }
}

// Whether a gift is currently holding the subscription's renewal off: an
// annual sub's period pushed out by trial_end, or a monthly sub's collection
// paused (routes/gift.ts extendSubscription). Gifts are the only thing that
// puts our subscriptions in either state.
export function giftExtensionRunning(sub: Stripe.Subscription): boolean {
  return sub.status === 'trialing' || sub.pause_collection != null
}

// When a cycle re-anchored to now next renews: one month or one year out,
// Stripe's own arithmetic for a `billing_cycle_anchor: 'now'` change.
export function oneCycleFromNowIso(plan: 'monthly' | 'yearly', now = new Date()): string {
  const next = new Date(now)
  if (plan === 'yearly') next.setUTCFullYear(next.getUTCFullYear() + 1)
  else next.setUTCMonth(next.getUTCMonth() + 1)
  // Jan 31 + 1 month overflows into March; Stripe clamps to the month's last day.
  if (next.getUTCDate() !== now.getUTCDate()) next.setUTCDate(0)
  return next.toISOString()
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

/**
 * What the subscription actually bills, in the subscription's own currency.
 *
 * `price.unit_amount` is stated in the PRICE's currency. Under the per-currency
 * `currency_options` scheme (server/lib/pricing.ts) every catalog price is
 * denominated in USD and carries the other 39 currencies as options, so for
 * every non-USD member `price.currency` is 'usd' while `sub.currency` is
 * theirs, and quoting unit_amount would be wrong money.
 *
 * Refusing to quote it was right; stopping there was not — it left every member
 * outside the base currency with no price on their plan card at all. The real
 * amount is one field over, in `currency_options[sub.currency].unit_amount`,
 * which Stripe only returns on an explicit expand. That expand is too deep to
 * ride along on the subscriptions.list call (`data.items.data.price` is already
 * at the limit), so it costs one price retrieve — and only for the members who
 * would otherwise see nothing.
 *
 * Null means "we could not establish this honestly": the card shows the renewal
 * date without inventing a figure.
 */
export async function subscriptionAmount(
  stripe: Stripe,
  sub: Stripe.Subscription,
  price: Stripe.Price,
): Promise<number | null> {
  if (price.currency === sub.currency) {
    return typeof price.unit_amount === 'number' ? price.unit_amount : null
  }
  try {
    const full = await stripe.prices.retrieve(price.id, { expand: ['currency_options'] })
    const localized = full.currency_options?.[sub.currency]?.unit_amount
    return typeof localized === 'number' ? localized : null
  } catch (err) {
    console.error('[stripe] currency_options read failed:', err)
    return null
  }
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
    return pm ? cardOf(pm) : null
  } catch {
    return null
  }
}

// The account page's view of a payment method, or null for anything that isn't
// a card (Link, a bank debit) — there is no "ending 4242" to show for those.
export function cardOf(pm: Stripe.PaymentMethod): CardOnFile | null {
  const card = pm.card
  if (!card) return null
  return {
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
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

// The subscription's current discounts as update params, by discount id. Passing
// them back by id (not by coupon) keeps each one's original start and end — a
// repeating promo doesn't restart its clock. `sub.discounts` is bare ids on a
// list call and objects when expanded; both are handled.
export function existingDiscountParams(
  sub: Pick<Stripe.Subscription, 'discounts'>,
): Array<{ discount: string }> {
  return (sub.discounts ?? []).map((d) => ({ discount: typeof d === 'string' ? d : d.id }))
}

// A schedule phase's discounts as update params. `subscriptionSchedules.update`
// REPLACES every phase, so a phase rebuilt without its `discounts` silently
// drops them — a checkout promo on the current period, or an intro coupon on
// the next. Reads whichever of discount / promotion_code / coupon the phase
// holds, in that order (an existing discount keeps its own clock).
export function phaseDiscountParams(
  discounts: Stripe.SubscriptionSchedule.Phase.Discount[] | null | undefined,
): Array<{ discount: string } | { promotion_code: string } | { coupon: string }> {
  const idOf = (x: string | { id: string } | null | undefined): string | null =>
    typeof x === 'string' ? x : (x?.id ?? null)
  const out: Array<{ discount: string } | { promotion_code: string } | { coupon: string }> = []
  for (const d of discounts ?? []) {
    const discount = idOf(d.discount)
    if (discount) {
      out.push({ discount })
      continue
    }
    const promotionCode = idOf(d.promotion_code)
    if (promotionCode) {
      out.push({ promotion_code: promotionCode })
      continue
    }
    const coupon = idOf(d.coupon)
    if (coupon) out.push({ coupon })
  }
  return out
}

// Add a coupon to a schedule's LAST phase — the pending change — leaving every
// phase otherwise as it is. The update replaces all phases, so each is passed
// back with its items, dates and discounts intact.
export async function addCouponToFinalPhase(
  stripe: Stripe,
  scheduleId: string,
  couponId: string,
): Promise<void> {
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
  const last = schedule.phases.length - 1
  await stripe.subscriptionSchedules.update(scheduleId, {
    phases: schedule.phases.map((p, i) => {
      const discounts = [
        ...phaseDiscountParams(p.discounts),
        ...(i === last ? [{ coupon: couponId }] : []),
      ]
      return {
        items: p.items.map((item) => ({
          price: typeof item.price === 'string' ? item.price : item.price.id,
          quantity: item.quantity ?? 1,
        })),
        start_date: p.start_date,
        end_date: p.end_date,
        ...(discounts.length > 0 ? { discounts } : {}),
      }
    }),
  })
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
