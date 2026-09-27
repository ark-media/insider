// What a plan change would do, before it's made: the price move, whether it's
// charged today or starts at period end, and the pay-what-you-can amount the
// confirm screen pre-fills. Shared by /api/stripe/change-preview (the billing
// page's cadence switch and "Change what I pay", and the Bundle upgrade panel)
// and change-tier, which bills what this quotes.

import type Stripe from 'stripe'
import { deriveEntitlements } from '../../entitlement.js'
import {
  isSupportedCurrency,
  minorUnitFactors,
  resolveCatalogPrice,
  roundMinorFor,
  type CatalogPrice,
  type Plan,
  type PricedTier,
} from '../../lib/pricing.js'
import {
  changeIsImmediate,
  giftExtensionRunning,
  oneCycleFromNowIso,
  periodEndIso,
  planFromSubscription,
  pwycMaxAmount,
  quoteChargeToday,
  subscriptionAmount,
  validatePwycAmount,
  type DestinationItem,
} from './helpers.js'
import { catalogTierOfSubscription } from './webhook.js'

// Stamped on the subscription at checkout when the buyer chose more than the
// minimum. It decides who gets the amount controls (amountChoiceOpen), and it
// outlives a later drop to the minimum: Stripe merges metadata on update, and
// nothing ever writes this key back.
export const CHOSE_ABOVE_FLOOR_KEY = 'chose_above_floor'

// The line item a change lands on: the catalog Price at the floor, an inline
// price on the catalog product above it.
export function destinationItem(
  catalog: CatalogPrice,
  amountCents: number,
  floor: number,
  currency: string,
  plan: Plan,
): DestinationItem {
  if (amountCents === floor) return { price: catalog.priceId }
  return {
    price_data: {
      currency,
      product: catalog.productId,
      unit_amount: amountCents,
      recurring: { interval: plan === 'monthly' ? 'month' : 'year' },
      tax_behavior: 'exclusive',
    },
  }
}

// Whether this member picks their own amount when they change plan, and can
// change what they pay at all. Hannah's rule (2026-09-27): only members who
// chose more than the minimum at checkout. Paying above the current floor
// counts too, for subscriptions from before the checkout stamp existed.
export function amountChoiceOpen(
  sub: Pick<Stripe.Subscription, 'metadata'>,
  currentCents: number | null,
  currentFloor: number | null,
): boolean {
  if (sub.metadata?.[CHOSE_ABOVE_FLOOR_KEY] === 'true') return true
  return currentCents !== null && currentFloor !== null && currentCents > currentFloor
}

// The amount a change pre-fills: the same proportion above the new minimum as
// the member pays above today's ($12 on an $8 minimum → $120 on an $80 one),
// rounded to a whole unit of the currency. A member at the minimum stays at it.
export function suggestedAmount(
  currentCents: number | null,
  currentFloor: number | null,
  newFloor: number,
  currency: string,
): number {
  if (currentCents === null || currentFloor === null || currentFloor <= 0) return newFloor
  if (currentCents <= currentFloor) return newFloor
  const factor = minorUnitFactors()[currency as keyof ReturnType<typeof minorUnitFactors>] ?? 100
  const whole = Math.round((newFloor * currentCents) / currentFloor / factor) * factor
  return Math.min(pwycMaxAmount(newFloor), Math.max(newFloor, roundMinorFor(whole, currency)))
}

export type ChangePreview = {
  tier: PricedTier
  plan: Plan
  currency: string
  minorFactor: number
  // What they pay now, on which cadence.
  currentCents: number | null
  currentPlan: Plan | null
  // The new tier/plan's minimum, and the amount this quote is for.
  floorCents: number
  amountCents: number
  // The amount picker, for members who chose above the minimum: where it
  // starts and how high it goes. Null means no picker; the change is at the
  // minimum.
  pwyc: { suggestedCents: number; maxCents: number } | null
  timing: 'immediate' | 'period_end'
  // Immediate changes: what comes off the card today (null when Stripe
  // couldn't quote it) and the restarted cycle's first renewal.
  dueTodayCents: number | null
  renewsAt: string | null
  // Period-end changes: when the new price starts.
  startsAt: string | null
  // Why the change can't be made right now, for the panel to say instead of
  // offering a button that would be refused.
  blocked: 'gift_extension' | null
}

// Quote a change on the member's live subscription. `amountCents` absent means
// "what would you suggest": the picker's pre-fill for a member who has one,
// the minimum for everyone else.
export async function previewChange(
  stripe: Stripe,
  sub: Stripe.Subscription,
  want: { tier: PricedTier; plan: Plan; amountCents?: number },
): Promise<ChangePreview | { error: string }> {
  const currentTier = await catalogTierOfSubscription(sub, stripe)
  const currentPlan = planFromSubscription(sub)
  if (!currentTier || currentTier === 'free' || !currentPlan) {
    return { error: 'This subscription can’t be changed here.' }
  }
  const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'
  const price = sub.items.data[0]?.price
  const currentCents = price ? await subscriptionAmount(stripe, sub, price) : null

  const [currentCatalog, catalog] = await Promise.all([
    resolveCatalogPrice(stripe, currentTier, currentPlan),
    resolveCatalogPrice(stripe, want.tier, want.plan),
  ])
  const currentFloor = currentCatalog.floors[currency] ?? null
  const floor = catalog.floors[currency] ?? catalog.floors.usd

  const open = amountChoiceOpen(sub, currentCents, currentFloor)
  // On the same plan (changing only the amount) the picker opens on what they
  // pay today; on a new one, at the same proportion above its minimum.
  const samePlan = currentTier === want.tier && currentPlan === want.plan
  const suggested = !open
    ? floor
    : samePlan && currentCents !== null && currentCents >= floor
      ? currentCents
      : suggestedAmount(currentCents, currentFloor, floor, currency)
  let amountCents = suggested
  if (want.amountCents !== undefined) {
    if (!open && want.amountCents !== floor) {
      return { error: 'Your plan changes at the standard price.' }
    }
    const checked = validatePwycAmount(want.amountCents, floor, currency)
    if ('error' in checked) return checked
    amountCents = checked.amountCents
  }

  const immediate = changeIsImmediate(
    deriveEntitlements(currentTier),
    deriveEntitlements(want.tier),
    currentCents,
    amountCents,
  )
  const blocked = immediate && giftExtensionRunning(sub) ? 'gift_extension' : null
  const dueTodayCents =
    immediate && !blocked
      ? await quoteChargeToday(
          stripe,
          sub,
          destinationItem(catalog, amountCents, floor, currency, want.plan),
          { tier: want.tier, plan: want.plan },
        )
      : null

  return {
    tier: want.tier,
    plan: want.plan,
    currency,
    minorFactor: minorUnitFactors()[currency] ?? 100,
    currentCents,
    currentPlan,
    floorCents: floor,
    amountCents,
    pwyc: open ? { suggestedCents: suggested, maxCents: pwycMaxAmount(floor) } : null,
    timing: immediate ? 'immediate' : 'period_end',
    dueTodayCents,
    renewsAt: immediate ? oneCycleFromNowIso(want.plan) : null,
    startsAt: immediate ? null : periodEndIso(sub),
    blocked,
  }
}
