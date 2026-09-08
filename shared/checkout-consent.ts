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
// TERMS_STATEMENT exactly.
// ---------------------------------------------------------------------------

export const TERMS_STATEMENT =
  'I agree to the Terms of Service and acknowledge the Privacy Policy.'

/**
 * `amount` is Stripe's own formatted, localized string for the next renewal
 * charge (currency symbol included), and `period` comes from billingPeriod
 * below — never a hand-built "$5.99" or "monthly", which would be wrong the
 * moment a buyer checks out in another currency or on a yearly plan.
 */
export function renewalStatement(amount: string, period: string): string {
  return `I understand my subscription renews automatically at ${amount} ${period} until I cancel.`
}

export type BillingInterval = 'day' | 'week' | 'month' | 'year'

/** "per month" / "per year", or "every 3 months" for a multi-interval price. */
export function billingPeriod(interval: BillingInterval, count: number): string {
  return count === 1 ? `per ${interval}` : `every ${count} ${interval}s`
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
