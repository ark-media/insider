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
// Gaining an entitlement is charged today and restarts the billing cycle from
// today (change-tier sends `billing_cycle_anchor: 'now'`): the member pays the
// full new price less credit for the unused part of the old one, then renews a
// full period from today.
//
// Three rules hold the copy together, and they are the reason these are
// functions rather than template fragments callers glue together:
//
//   1. Quote a price per billing period, in the member's own cadence. A yearly
//      member reading "a month" is being told the wrong number.
//   2. Say what comes off the card today, out loud, with the figure when we
//      have it. Nobody should learn the answer from their bank statement.
//   3. No "prorated", no "invoice", no "billing period". Members have bills and
//      months; proration is our word for our machinery.
// ---------------------------------------------------------------------------

export type BillingPlan = 'monthly' | 'yearly'

/** "a month" / "a year" — a price is always quoted per billing period. */
export function perPeriod(plan: BillingPlan): string {
  return plan === 'yearly' ? 'a year' : 'a month'
}

/**
 * What today's charge is. `nothing` is a pay-what-you-can member whose unused
 * time already covers the new price; `unknown` is a quote we couldn't get, and
 * takes the phrasing that is true whatever the figure.
 */
export type DueToday = { amount: string } | 'nothing' | 'unknown'

/** A quoted charge (minor units, null when unquoted) as a DueToday. */
export function dueTodayOf(
  cents: number | null | undefined,
  format: (cents: number) => string,
): DueToday {
  if (cents == null) return 'unknown'
  if (cents <= 0) return 'nothing'
  return { amount: format(cents) }
}

/** Rule 2, as a sentence. `amount` is formatted (and escaped for HTML) by the caller. */
export function dueTodayLine(due: DueToday): string {
  if (due === 'nothing') return "Nothing to pay today: what's left of your current plan covers it."
  if (due === 'unknown') {
    return "You pay the new price today, less credit for what's left of your current plan."
  }
  return `You pay ${due.amount} today: the new price, less credit for what's left of your current plan.`
}

/** When the restarted cycle next renews. Without a readable date, says it by cadence. */
export function renewsLine(p: { plan: BillingPlan; renewsOn: string | null }): string {
  return p.renewsOn
    ? `Your membership then renews on ${p.renewsOn}.`
    : `Your membership then renews ${perPeriod(p.plan)} from today.`
}

/**
 * The same facts after the fact, for the follow-up email. That renderer is told
 * the new price, never the old one or the charge, so it states how today's bill
 * was worked out rather than a figure — Stripe's receipt carries the figure.
 */
export const SETTLED_TODAY =
  "Today's bill was the new price, less credit for what was left of your old plan."
