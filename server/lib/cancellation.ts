// cancellation_survey persistence. Thin SQL helpers over the Neon client,
// kept apart from the route so the column shape lives in one place and the
// insert is easy to read. Validation of the inputs (reason slug, outcome)
// happens at the route boundary against shared/cancellation.ts.

import type { Sql } from './db.js'
import type {
  CancellationSummary,
  OfferOutcome,
} from '../../shared/cancellation.js'

export type CancellationSurveyInput = {
  email: string
  reason: string | null
  note: string | null
  offerOutcome: OfferOutcome
  couponId: string | null
}

// Insert one survey row. Returns the new id. Callers decide whether a failure
// here is fatal — a cancel shouldn't be blocked by an analytics write, but an
// accept must record its row (it's how eligibility burns).
export async function insertCancellationSurvey(
  sql: Sql,
  input: CancellationSurveyInput,
): Promise<void> {
  await sql`
    insert into cancellation_survey (email, reason, note, offer_outcome, coupon_id)
    values (
      ${input.email},
      ${input.reason},
      ${input.note},
      ${input.offerOutcome},
      ${input.couponId}
    )`
}

// Has this email ever accepted a retention offer? Eligibility burns only on
// accept (decliners stay "unused"), so a single accepted row makes the member
// ineligible forever — and guards the accept endpoint against writing a
// duplicate row on a double-click.
export async function hasAcceptedRetention(sql: Sql, email: string): Promise<boolean> {
  const rows = await sql`
    select 1 from cancellation_survey
    where email = ${email} and offer_outcome = 'accepted'
    limit 1`
  return rows.length > 0
}

// Aggregates for the admin cancellations view: counts by outcome, counts by
// reason, and the most recent rows. `limit` caps the recent list.
export async function getCancellationSummary(
  sql: Sql,
  limit = 50,
): Promise<CancellationSummary> {
  const [byOutcome, byReason, recent] = await Promise.all([
    sql`select offer_outcome as outcome, count(*)::int as count
        from cancellation_survey
        group by offer_outcome
        order by count desc`,
    sql`select reason, count(*)::int as count
        from cancellation_survey
        where reason is not null
        group by reason
        order by count desc`,
    sql`select email, reason, note, offer_outcome, coupon_id, created_at
        from cancellation_survey
        order by created_at desc
        limit ${limit}`,
  ])
  return {
    byOutcome: byOutcome as { outcome: string; count: number }[],
    byReason: byReason as { reason: string; count: number }[],
    recent: (recent as Record<string, unknown>[]).map((r) => ({
      email: r.email as string,
      reason: (r.reason as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      offerOutcome: r.offer_outcome as string,
      couponId: (r.coupon_id as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
    })),
  }
}
