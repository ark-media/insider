// ---------------------------------------------------------------------------
// The sentences a buyer actively ticks before we charge them.
//
// Counsel's requirement, and the reason this is two checkboxes at the pay
// button rather than one line of prose anywhere earlier: consent has to be an
// act, it has to be adjacent to the charge, and the recurring charge has to be
// named in the same breath. A "by continuing you agree…" line on the email
// screen satisfied none of those.
//
// The strings live here, shared by three consumers that must not drift:
//   1. the checkbox labels the buyer reads (src/components/CheckoutConsent),
//   2. the record stamped on the Stripe Checkout Session, which is the evidence
//      we can produce months later (POST /api/stripe/record-consent),
//   3. the tests that pin both.
// The labels render the two policy names as links, so the component builds the
// same sentence out of JSX; a test asserts its textContent still equals
// termsStatement(age) exactly, age clause included.
// ---------------------------------------------------------------------------

export const TERMS_STATEMENT =
  'I agree to the Terms of Service and acknowledge the Privacy Policy.'

/**
 * Who the 18+ clause is about.
 *
 * The Fold is an adults-only community, so every purchase that grants the
 * `circle` axis asks for an age confirmation. It rides INSIDE the terms
 * sentence rather than arriving as a third box: a buyer who won't tick the
 * terms can't pay anyway, so a separate tick would add a click without adding a
 * decision — and the combined sentence is what gets stamped on the Session, so
 * the record still names exactly what was confirmed.
 *
 * Two strings rather than one with the pronoun swapped, because they are not
 * the same record. 'self' is a buyer attesting about themselves. 'recipient' is
 * a giver attesting about someone else, who is the person that will actually be
 * in the Fold — a weaker claim, and one that must never be read back as if the
 * member had made it.
 */
export type AgeAttestation = 'self' | 'recipient'

export const AGE_STATEMENT: Record<AgeAttestation, string> = {
  self: 'I confirm that I am 18 years or older.',
  recipient: 'I confirm the recipient is 18 years or older.',
}

/**
 * The terms sentence for a purchase, with the age clause when the tier carries
 * the Fold. Null `age` is the plain sentence — Ark+ has nothing to confirm.
 */
export function termsStatement(age: AgeAttestation | null): string {
  return age === null
    ? TERMS_STATEMENT
    : `${TERMS_STATEMENT} ${AGE_STATEMENT[age]}`
}

/** The tiers a buyer can put in a cart — gift and subscription alike. */
export type PurchasableTier = 'ark-plus' | 'circle' | 'bundle'

/**
 * Whether this purchase asks about age, and on whose behalf. The single place
 * that knows which tiers include the Fold: a fourth tier, or a fourth door onto
 * the Fold, changes this function and nothing else. `who` is the caller's to
 * say — only it knows whether the person at the keyboard is the one who'll be
 * in the community.
 */
export function ageAttestationFor(
  tier: PurchasableTier,
  who: AgeAttestation,
): AgeAttestation | null {
  return tier === 'circle' || tier === 'bundle' ? who : null
}

/**
 * `amount` is Stripe's own formatted, localized string for the next renewal
 * charge (currency symbol included), and `period` comes from billingPeriod
 * below — never a hand-built "$5.99" or "monthly", which would be wrong the
 * moment a buyer checks out in another currency or on a yearly plan.
 *
 * `amount` is null when the Session doesn't carry a renewal figure we can
 * trust, and then the sentence is asked WITHOUT one. The alternative — naming
 * today's total instead — quotes a number we know is not the recurring charge
 * (a first-period discount and today's tax are both in it), and this string is
 * also what gets stamped on the Session as the record of what the buyer agreed
 * to. A subscription must never lose the sentence, only its precision.
 */
export function renewalStatement(amount: string | null, period: string): string {
  return amount === null
    ? `I understand my subscription renews automatically ${asCadence(period)} until I cancel.`
    : `I understand my subscription renews automatically at ${amount} ${period} until I cancel.`
}

export type BillingInterval = 'day' | 'week' | 'month' | 'year'

/** "per month" / "per year", or "every 3 months" for a multi-interval price. */
export function billingPeriod(interval: BillingInterval, count: number): string {
  return count === 1 ? `per ${interval}` : `every ${count} ${interval}s`
}

// The same cadence as an adverb — "every month" where billingPeriod says "per
// month" — for the sentence with no figure in front of it, which "renews
// automatically per month" would leave ungrammatical. Total over billingPeriod's
// own output: its multi-interval form ("every 3 months") already reads this way.
function asCadence(period: string): string {
  return period.startsWith('per ') ? `every ${period.slice(4)}` : period
}

// Bounds for the recorded copy. Stripe caps a metadata value at 500 characters,
// and the statements are sent by the browser — a client we don't trust to be
// terse or honest about its own length.
export const MAX_CONSENT_STATEMENTS = 4
export const MAX_CONSENT_STATEMENT_LEN = 400

/**
 * The metadata key a statement is stamped under, 1-indexed in the order it was
 * shown. Alongside them the server writes `consent_accepted_at` — its own
 * clock, not the browser's.
 */
export function consentStatementKey(index: number): string {
  return `consent_statement_${index + 1}`
}

export const CONSENT_ACCEPTED_AT_KEY = 'consent_accepted_at'
