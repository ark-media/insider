// ---------------------------------------------------------------------------
// The sentences a member reads about a change to what they pay.
//
// One switch to the Bundle produces two of them: the confirm panel the member
// reads before agreeing, and the email that arrives once it goes through. They
// describe the same event, so they have to say the same thing — which they did
// not while each side kept its own copy of "a month", "the rest of this month"
// and "Nothing to pay today", and the success banner had quietly hardcoded the
// monthly wording for yearly members. This module is the only place that
// wording lives.
//
// Three rules hold the copy together, and they are the reason these are
// functions rather than template fragments callers glue together:
//
//   1. Quote a price per billing period, in the member's own cadence. A yearly
//      member reading "a month" is being told the wrong number.
//   2. Say "nothing to pay today" out loud. It is the true answer and nobody
//      guesses it, because the change settles on the next bill instead.
//   3. No "prorated", no "invoice", no "billing period". Members have bills and
//      months; proration is our word for our machinery.
// ---------------------------------------------------------------------------

export type BillingPlan = 'monthly' | 'yearly'

/** "a month" / "a year" — a price is always quoted per billing period. */
export function perPeriod(plan: BillingPlan): string {
  return plan === 'yearly' ? 'a year' : 'a month'
}

/** "the rest of this month" / "the rest of this year". */
export function restOfPeriod(plan: BillingPlan): string {
  return plan === 'yearly' ? 'the rest of this year' : 'the rest of this month'
}

/** Rule 2, as a sentence. Always precedes a next-bill line. */
export const NOTHING_TO_PAY_TODAY = 'Nothing to pay today.'

/**
 * Which way the change settles on the next bill. A pay-what-you-can member
 * paying MORE than the bundle is owed the unused remainder rather than charged
 * a difference — same "nothing today", opposite direction afterwards.
 *
 * `unknown` is a real answer, not a missing one: the email renderer is told
 * what the membership costs now, never what it cost before, so it takes the
 * phrasing that is true whichever way the money went.
 */
export type Settlement = 'charged' | 'credited' | 'unknown'

/**
 * What the next bill does about the change. Built whole rather than glued from
 * clauses: without a readable date the clause-by-clause version ran together
 * into "Your next bill with the difference…".
 *
 * `renewsOn` is a formatted date, already escaped by the caller when the
 * destination is HTML.
 */
export function nextBillLine(p: {
  plan: BillingPlan
  renewsOn: string | null
  settlement: Settlement
}): string {
  const rest = restOfPeriod(p.plan)
  if (p.settlement === 'credited') {
    return p.renewsOn
      ? `Your next bill is ${p.renewsOn}, with credit for what you've already paid.`
      : `Your next bill comes with credit for what you've already paid.`
  }
  if (p.settlement === 'charged') {
    return p.renewsOn
      ? `Your next bill is ${p.renewsOn}, with the difference for ${rest} added on.`
      : `Your next bill picks up the difference for ${rest}.`
  }
  return p.renewsOn
    ? `Your next bill is ${p.renewsOn}, and it covers ${rest} at the new price.`
    : `Your next bill covers ${rest} at the new price.`
}
