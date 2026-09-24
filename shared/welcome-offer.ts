// The ICMB welcome offer's member-facing facts — the ones the browser needs as
// well as the server.
//
// They live in shared/ rather than server/lib/welcome-offer.ts because the
// account page has to decide, without a round trip, whether the offer is even
// worth asking about: the eligibility check reads Stripe, and firing it on
// every account load for every member — for a campaign that touches a few
// hundred people for four weeks — would be a lot of work to answer "no".
//
// server/lib/welcome-offer.ts re-exports these, so the server and the scripts
// keep importing the offer's constants from one place.

// Oct 31 2026, 23:59:59 Eastern — the US had not yet left DST that night, so
// Eastern is UTC-4. This is the coupons' `redeem_by`, so Stripe itself refuses
// a late redemption.
export const WELCOME_OFFER_REDEEM_BY_ISO = '2026-11-01T03:59:59Z'

// The same moment as the member reads it. Written out rather than formatted
// from the ISO above: that instant renders as 1 November everywhere east of
// Eastern, and the deadline members were told is the 31st.
export const WELCOME_OFFER_CLOSES_LABEL = '31 October 2026'

export const WELCOME_MONTHLY_DISCOUNT_MONTHS = 3

/** Whether the offer can still be redeemed. */
export function welcomeOfferIsOpen(now: Date = new Date()): boolean {
  return now.getTime() <= Date.parse(WELCOME_OFFER_REDEEM_BY_ISO)
}
