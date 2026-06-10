// cancellation_survey persistence. Thin SQL helpers over the Neon client,
// kept apart from the route so the column shape lives in one place and the
// insert is easy to read. Validation of the inputs (reason slug, outcome)
// happens at the route boundary against shared/cancellation.ts.

import type { Sql } from './db.js'
import {
  outcomeLabel,
  reasonLabel,
  type CancellationFilter,
  type CancellationRow,
  type CancellationSummary,
  type OfferOutcome,
} from '../../shared/cancellation.js'
import { toCsv } from './csv.js'

export type CancellationSurveyInput = {
  email: string
  reason: string | null
  note: string | null
  offerOutcome: OfferOutcome
  couponId: string | null
}

// Insert one survey row. Callers decide whether a failure here is fatal — a
// cancel shouldn't be blocked by an analytics write, but an accept records the
// row that burns eligibility. `on conflict do nothing` against the partial
// unique index (migrations/0003) makes a duplicate 'accepted' row a no-op
// rather than an error, so a raced double-accept can't throw; the arbiter only
// covers accepted rows, so declined/not_offered inserts are unaffected.
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
    )
    on conflict (email) where offer_outcome = 'accepted' do nothing`
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

// Defensive upper bound on a CSV export. The survey table is small for this
// app, but an unbounded select over the HTTP driver is a smell; this caps the
// response well above any realistic cancellation volume.
const EXPORT_ROW_CAP = 100_000

// Builds the parameterized row query with optional outcome/reason filters.
// Filters are bound as $1/$2 (never concatenated). `limit` is null for the
// full export. Validation of the filter values happens at the route boundary.
function buildRowQuery(
  filter: CancellationFilter | undefined,
  limit: number | null,
): { text: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (filter?.outcome) {
    params.push(filter.outcome)
    where.push(`offer_outcome = $${params.length}`)
  }
  if (filter?.reason) {
    params.push(filter.reason)
    where.push(`reason = $${params.length}`)
  }
  let text = `select email, reason, note, offer_outcome, coupon_id, created_at
    from cancellation_survey`
  if (where.length) text += ` where ${where.join(' and ')}`
  text += ` order by created_at desc`
  if (limit !== null) {
    params.push(limit)
    text += ` limit $${params.length}`
  }
  return { text, params }
}

function mapRow(r: Record<string, unknown>): CancellationRow {
  return {
    email: r.email as string,
    reason: (r.reason as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    offerOutcome: r.offer_outcome as string,
    couponId: (r.coupon_id as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  }
}

// Survey rows newest-first, optionally filtered by outcome/reason. Used for the
// admin recent list (capped) and the CSV export (capped at EXPORT_ROW_CAP).
export async function getCancellationRows(
  sql: Sql,
  filter?: CancellationFilter,
  limit: number | null = EXPORT_ROW_CAP,
): Promise<CancellationRow[]> {
  const { text, params } = buildRowQuery(filter, limit)
  const rows = (await sql.query(text, params)) as Record<string, unknown>[]
  return rows.map(mapRow)
}

// Aggregates for the admin cancellations view: counts by outcome, counts by
// reason, and the most recent rows. The two count breakdowns are always global
// (the overview); only `recent` honours `filter`. `limit` caps the recent list.
export async function getCancellationSummary(
  sql: Sql,
  opts: { limit?: number; filter?: CancellationFilter } = {},
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
    getCancellationRows(sql, opts.filter, opts.limit ?? 50),
  ])
  return {
    byOutcome: byOutcome as { outcome: string; count: number }[],
    byReason: byReason as { reason: string; count: number }[],
    recent,
  }
}

// Renders survey rows as a CSV using the same human labels as the admin table,
// so an exported file reads identically to what an admin sees on screen.
export function cancellationRowsToCsv(rows: CancellationRow[]): string {
  const headers = ['Date', 'Email', 'Outcome', 'Reason', 'Note', 'Coupon']
  const body = rows.map((r) => [
    r.createdAt,
    r.email,
    outcomeLabel(r.offerOutcome),
    reasonLabel(r.reason) ?? '',
    r.note ?? '',
    r.couponId ?? '',
  ])
  return toCsv(headers, body)
}
