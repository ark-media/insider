// ICMB launch welcome offer — roster, eligibility and bookkeeping.
//
// Existing Inside Call Me Back subscribers are invited to move from Ark+ to the
// Bundle keeping their cadence, at a fixed discounted price for a fixed term
// ($200 the first year / $20 for three months). The two Stripe coupons are
// provisioned by scripts/welcome-offer-coupons.ts; the roster of who may use
// them lives in `welcome_offer_codes` (migration 0008) rather than as Stripe
// promotion codes, because stripe-promos.ts pages promotion codes 100 at a time
// for 20 pages and a few thousand personal codes would push the house-sale code
// past the end of that scan.
//
// The code is the link-carrier, not the credential. Redeeming charges a card,
// so the route behind this runs `requireBillingEmail` — a real sign-in, never
// an emailed link — and eligibility is decided by the SIGNED-IN member's email
// matching a roster row. A forwarded email is therefore worthless to anyone but
// its owner, and the code only has to be unguessable enough not to be a nuisance.
//
// Everything here is either a constant shared with the provisioning script or a
// small SQL helper. The Stripe side of redemption lives in routes/offer.ts.

import type { Sql } from './db.js'
import { normalizeEmail } from './feed-activations.js'
import { roundMinorFor, type Plan } from './pricing.js'
import { welcomeOfferIsOpen } from '../../shared/welcome-offer.js'

// Re-exported so the server side reaches the offer's constants through this
// module. The browser-only ones (the closing-date label, the window predicate)
// are imported straight from shared/ by the pages that need them.
export {
  WELCOME_MONTHLY_DISCOUNT_MONTHS,
  WELCOME_OFFER_REDEEM_BY_ISO,
} from '../../shared/welcome-offer.js'

// The campaign. One roster row per (email, cohort), so a second campaign later
// reuses this table without a schema change.
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

// A claim older than this is treated as abandoned and may be re-taken. Long
// enough that two rapid clicks can't both proceed, short enough that a request
// which died mid-Stripe-call doesn't lock a member out of the offer.
const CLAIM_TTL_SECONDS = 300

// Codes are read off a screen and typed into nothing — they travel in a link —
// but they do get read aloud to support, so the alphabet drops the characters
// that get confused (0/O, 1/I/L, 5/S, 8/B). 2 groups of 4 from a 30-character
// alphabet is ~39 bits, which is plenty when the code is not the credential.
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ234679'
const CODE_PREFIX = 'CMB'

export function generateOfferCode(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
  return `${CODE_PREFIX}-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

export type OfferRow = {
  code: string
  email: string
  cohort: string
  sent_at: string | null
  claimed_at: string | null
  redeemed_at: string | null
  redeemed_subscription_id: string | null
  redeemed_plan: string | null
}

// Why a member can't take the offer, or null if they can. `expired` is checked
// here as well as by Stripe's `redeem_by` so the page can say so plainly rather
// than surfacing a Stripe error.
export type OfferBlock = 'not_invited' | 'already_redeemed' | 'expired'

export function blockFor(
  row: OfferRow | null,
  now: Date = new Date(),
): OfferBlock | null {
  if (!row) return 'not_invited'
  if (row.redeemed_at) return 'already_redeemed'
  if (!welcomeOfferIsOpen(now)) return 'expired'
  return null
}

export async function findOffer(
  sql: Sql,
  email: string,
  cohort: string = WELCOME_OFFER_COHORT,
): Promise<OfferRow | null> {
  const rows = (await sql`
    select code, email, cohort, sent_at, claimed_at, redeemed_at,
           redeemed_subscription_id, redeemed_plan
      from welcome_offer_codes
     where email = ${normalizeEmail(email)} and cohort = ${cohort}
     limit 1
  `) as OfferRow[]
  return rows[0] ?? null
}

// Take the offer for this member, atomically. Returns the code on success and
// null when there is nothing to claim — already redeemed, never invited, or
// another request is mid-redemption. The condition IS the lock: two concurrent
// calls both run this UPDATE and exactly one matches a row.
export async function claimOffer(
  sql: Sql,
  email: string,
  cohort: string = WELCOME_OFFER_COHORT,
): Promise<string | null> {
  const rows = (await sql`
    update welcome_offer_codes
       set claimed_at = now()
     where email = ${normalizeEmail(email)}
       and cohort = ${cohort}
       and redeemed_at is null
       and (claimed_at is null
            or claimed_at < now() - make_interval(secs => ${CLAIM_TTL_SECONDS}))
    returning code
  `) as Array<{ code: string }>
  return rows[0]?.code ?? null
}

// Hand the offer back after a failed upgrade, so the member can try again with
// a working card instead of waiting out the claim window.
export async function releaseClaim(sql: Sql, code: string): Promise<void> {
  await sql`
    update welcome_offer_codes
       set claimed_at = null
     where code = ${code} and redeemed_at is null
  `
}

export async function markRedeemed(
  sql: Sql,
  code: string,
  result: {
    subscriptionId: string
    invoiceId: string | null
    plan: Plan
    couponId: string
  },
): Promise<void> {
  await sql`
    update welcome_offer_codes
       set redeemed_at              = now(),
           redeemed_subscription_id = ${result.subscriptionId},
           redeemed_invoice_id      = ${result.invoiceId},
           redeemed_plan            = ${result.plan},
           redeemed_coupon_id       = ${result.couponId}
     where code = ${code}
  `
}

// Roster insert, used by scripts/welcome-offer-codes.ts. `on conflict do
// nothing` on (email, cohort) so re-running the generator over a superset of
// the list tops it up instead of handing anyone a second code.
export async function insertOfferCode(
  sql: Sql,
  entry: { code: string; email: string; cohort?: string },
): Promise<boolean> {
  const rows = (await sql`
    insert into welcome_offer_codes (code, email, cohort)
    values (${entry.code}, ${normalizeEmail(entry.email)}, ${entry.cohort ?? WELCOME_OFFER_COHORT})
    on conflict (email, cohort) do nothing
    returning code
  `) as Array<{ code: string }>
  return rows.length > 0
}

// Stamp the whole cohort as mailed, on the day the send goes out. Kept separate
// from the insert because the roster is generated before the email is sent, and
// `sent_at` should say when it actually went.
export async function markCohortSent(
  sql: Sql,
  cohort: string = WELCOME_OFFER_COHORT,
): Promise<number> {
  const rows = (await sql`
    update welcome_offer_codes
       set sent_at = now()
     where cohort = ${cohort} and sent_at is null
    returning code
  `) as Array<{ code: string }>
  return rows.length
}
