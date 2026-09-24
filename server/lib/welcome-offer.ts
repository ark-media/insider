// ICMB launch welcome offer — eligibility, pricing and the no-stacking rule.
//
// Existing Inside Call Me Back subscribers are invited to move from Ark+ to the
// Bundle keeping their cadence, at a fixed discounted price for a fixed term
// ($200 the first year / $20 for three months). The two Stripe coupons are
// provisioned by scripts/welcome-offer-coupons.ts, and the invitation is sent
// by scripts/welcome-offer-send.ts.
//
// There is no roster. Who may redeem is a fact Stripe already holds — an Ark+
// subscription that predates launch (WELCOME_OFFER_ELIGIBLE_BEFORE_ISO) — and
// who HAS redeemed is written onto the subscription itself. Redeeming charges a
// card, so the route behind this runs `requireBillingEmail` (a real sign-in, or
// the offer email's own link while it is under 48 hours old) and reads the
// SIGNED-IN member's own subscription. Within those 48 hours whoever holds the
// link acts as its owner — a forwarded email included — but only ever on the
// owner's own subscription and card.
//
// Everything here is pure. The Stripe side of redemption lives in
// routes/offer.ts.

import { roundMinorFor, type Plan } from './pricing.js'
import {
  WELCOME_MONTHLY_DISCOUNT_MONTHS,
  welcomeOfferIsOpen,
} from '../../shared/welcome-offer.js'

// Re-exported so the server side reaches the offer's constants through this
// module. The browser-only ones (the closing-date label, the window predicate)
// are imported straight from shared/ by the pages that need them.
export {
  WELCOME_MONTHLY_DISCOUNT_MONTHS,
  WELCOME_OFFER_REDEEM_BY_ISO,
} from '../../shared/welcome-offer.js'

// The campaign, as stamped on a redeemed subscription and in the lock key.
export const WELCOME_OFFER_COHORT = 'icmb_launch_2026'

// Coupon ids, fixed so the provisioning script is idempotent and the route can
// name the coupon without a lookup.
export const WELCOME_OFFER_COUPON_ID: Record<Plan, string> = {
  yearly: 'icmb_welcome_yearly',
  monthly: 'icmb_welcome_monthly',
}

// The quoted USD prices, in minor units: $200 for the first year, $20 for each
// of the first three months. Every other currency is derived from the catalog's
// Bundle price at this ratio (scripts/welcome-offer-coupons.ts) rather than
// restated, so the table can never drift from what is actually charged.
export const WELCOME_OFFER_USD_MINOR: Record<Plan, number> = {
  yearly: 20_000,
  monthly: 2_000,
}

// What this offer charges in one currency, derived from the catalog's own
// Bundle price for that cadence. $200/yr and $20/mo are exactly the catalog's
// $20-per-month anchor, so the offer price in any other currency is that
// currency's Bundle price scaled by the same USD ratio, rounded the way the
// rest of the server rounds derived amounts (whole units for HUF/TWD).
//
// Deriving it beats restating a 40-row table: the coupons the provisioning
// script mints and the figures the account page shows are then the same
// arithmetic over the same source, and neither can drift from what Stripe
// actually charges. `floors` is a resolved CatalogPrice's per-currency table.
export function offerAmountFor(
  floors: Record<string, number>,
  plan: Plan,
  currency: string,
): { bundleMinor: number; offerMinor: number; discountMinor: number } {
  const usdBundle = floors.usd
  const bundleMinor = floors[currency] ?? usdBundle
  const ratio = WELCOME_OFFER_USD_MINOR[plan] / usdBundle
  const offerMinor = roundMinorFor(bundleMinor * ratio, currency)
  return { bundleMinor, offerMinor, discountMinor: bundleMinor - offerMinor }
}

// The audience, stated as a fact Stripe already holds: every subscription that
// was on Ark+ before launch. At launch nobody is on the Circle or the Bundle
// yet, so "on Stripe before 5 October" and "an existing ICMB subscriber" are
// the same set of people — and deciding it from Stripe means there is no roster
// to generate, keep in sync, or lose. Midnight Eastern on launch day (EDT, so
// UTC-4); the send script and the redeem route read the same constant, so
// whoever is mailed is exactly whoever may redeem.
export const WELCOME_OFFER_ELIGIBLE_BEFORE_ISO = '2026-10-05T04:00:00Z'

// Written onto the subscription when the offer is redeemed. Stripe is the only
// record of who took it: the cohort marker says which campaign, and the date
// and cadence say when the discounted terms run out (welcomeDiscountActive).
export const WELCOME_OFFER_KEY = 'welcome_offer'
export const WELCOME_OFFER_REDEEMED_AT_KEY = 'welcome_offer_redeemed_at'
export const WELCOME_OFFER_PLAN_KEY = 'welcome_offer_plan'

// Why a member can't take the offer, or null if they can. `expired` is checked
// here as well as by Stripe's `redeem_by` so the page can say so plainly rather
// than surfacing a Stripe error.
export type OfferBlock = 'not_eligible' | 'already_bundle' | 'expired'

export function blockFor(
  sub: { created: number; metadata?: Record<string, string> | null },
  tier: string | null,
  now: Date = new Date(),
): OfferBlock | null {
  // Before the window check: someone who took it should hear that, not
  // "closed", when they come back in November.
  if (tier === 'bundle' || sub.metadata?.[WELCOME_OFFER_KEY]) return 'already_bundle'
  if (tier !== 'ark-plus') return 'not_eligible'
  if (sub.created * 1000 >= Date.parse(WELCOME_OFFER_ELIGIBLE_BEFORE_ISO)) return 'not_eligible'
  if (!welcomeOfferIsOpen(now)) return 'expired'
  return null
}

// Whether the member is still inside their discounted terms — the first year,
// or the first three months. The cancel flow's coupon saves are priced off the
// list price, so layering one over the welcome price would quote the member a
// number they won't be charged and compound two discounts. Plan switches stay
// on offer; only the coupons wait until the welcome price has run out.
//
// Read from the metadata the redemption writes rather than from the discount
// itself: a `duration: once` coupon's discount carries no end date, so "is it
// still running" can't be answered from Stripe's discount object for the
// yearly offer. A marker without a readable date (the post-charge metadata
// write failed) counts as active — the safe direction is withholding a second
// discount, not granting one.
export function welcomeDiscountActive(
  metadata: Record<string, string> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!metadata?.[WELCOME_OFFER_KEY]) return false
  const redeemedAt = Date.parse(metadata[WELCOME_OFFER_REDEEMED_AT_KEY] ?? '')
  if (Number.isNaN(redeemedAt)) return true
  const ends = new Date(redeemedAt)
  ends.setUTCMonth(
    ends.getUTCMonth() +
      (metadata[WELCOME_OFFER_PLAN_KEY] === 'yearly' ? 12 : WELCOME_MONTHLY_DISCOUNT_MONTHS),
  )
  return now.getTime() < ends.getTime()
}

// The lock against a double charge, with no table to hold it: Stripe's own
// idempotency. Two concurrent redemptions send the same key, so the second
// gets Stripe's answer to the first instead of a second charge. The card is in
// the key because Stripe also replays a DECLINE for 24 hours — a member who
// updates their card (which lands on the subscription's default_payment_method)
// gets a fresh key and a real retry, while one who retries on the same card
// hears the same decline. After a success the subscription is on the Bundle,
// so blockFor stops any later attempt before it reaches Stripe.
export function redeemIdempotencyKey(sub: {
  id: string
  default_payment_method?: string | { id: string } | null
}): string {
  const pm = sub.default_payment_method
  const pmId = typeof pm === 'string' ? pm : (pm?.id ?? 'customer-default')
  return `welcome-offer:${WELCOME_OFFER_COHORT}:${sub.id}:${pmId}`
}
