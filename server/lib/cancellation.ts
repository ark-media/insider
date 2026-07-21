// cancellation_survey persistence. Thin SQL helpers over the Neon client,
// kept apart from the route so the column shape lives in one place and the
// insert is easy to read. Validation of the inputs (reason slug, outcome)
// happens at the route boundary against shared/cancellation.ts.

import type { Sql } from './db.js'
import {
  outcomeLabel,
  reasonLabel,
  retainedProductLabel,
  type CancellationFilter,
  type CancellationRow,
  type CancellationSummary,
  type OfferOutcome,
} from '../../shared/cancellation.js'
import type { OfferKind } from '../../shared/retention.js'
import { toCsv } from './csv.js'

// Promotional coupons are redeemable at most once per rolling window; older
// acceptances no longer block a new offer (Decision #6). Plan switches are never
// rate-limited — see offerBlockedByWindow.
export const RETENTION_WINDOW_MONTHS = 12

// Is a prior coupon-accept still inside the rolling eligibility window? A null
// timestamp (never accepted) is always outside. Pure so the window rule is unit
// testable without a database.
export function withinRetentionWindow(acceptedAt: Date | null, now: Date): boolean {
  if (!acceptedAt) return false
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - RETENTION_WINDOW_MONTHS)
  return acceptedAt.getTime() > cutoff.getTime()
}

// Plan switches (annual↔monthly) are never rate-limited; only promotional
// coupons are (Decision #6). Given an offer kind and the member's most recent
// coupon-accept time, decide whether this specific offer is blocked right now.
const PLAN_SWITCH_KINDS = new Set<OfferKind>(['annual_switch', 'monthly_switch'])
export function offerBlockedByWindow(
  kind: OfferKind,
  lastCouponAcceptAt: Date | null,
  now: Date,
): boolean {
  if (PLAN_SWITCH_KINDS.has(kind)) return false
  return withinRetentionWindow(lastCouponAcceptAt, now)
}

export type CancellationSurveyInput = {
  email: string
  // Multi-select reason slugs (empty for an accept row, or a cancel whose survey
  // is collected afterward via updateCancellationSurveyReasons).
  reasons: string[]
  note: string | null
  offerOutcome: OfferOutcome
  couponId: string | null
  // Win-back record (0012): the tier left and what was kept. Optional so the
  // accept path (a stay) and older callers omit them; default to null.
  canceledTier?: string | null
  retainedProduct?: string | null
}

// The generated identity of an inserted survey row. Returned so the cancel flow
// can attach the member's reasons afterward (survey-after-cancel).
export type SurveyId = string | number

// Insert one survey row, returning its id. Callers decide whether a failure here
// is fatal — a cancel shouldn't be blocked by an analytics write, but an accept
// records the row the window check reads. The once-ever unique index
// (migrations/0003) was relaxed in 0011 so a member can re-accept across time, so
// there is no ON CONFLICT arbiter here; the accept endpoint's read-then-write
// window guard prevents a within-window repeat, and a rare raced double-accept
// only writes a duplicate analytics row (harmless — the window still blocks the
// next attempt).
export async function insertCancellationSurvey(
  sql: Sql,
  input: CancellationSurveyInput,
): Promise<SurveyId> {
  const rows = await sql`
    insert into cancellation_survey
      (email, reasons, note, offer_outcome, coupon_id, canceled_tier, retained_product)
    values (
      ${input.email},
      ${input.reasons},
      ${input.note},
      ${input.offerOutcome},
      ${input.couponId},
      ${input.canceledTier ?? null},
      ${input.retainedProduct ?? null}
    )
    returning id`
  return (rows[0] as { id: SurveyId }).id
}

// Attach the member's checked reasons + free-text note to an existing survey row
// after a cancel has already committed (survey-after-cancel). Scoped by email so
// a member can only annotate their own row. Idempotent-ish: re-submitting just
// overwrites. `email` is the authz check, not an update target.
export async function updateCancellationSurveyReasons(
  sql: Sql,
  input: { id: SurveyId; email: string; reasons: string[]; note: string | null },
): Promise<void> {
  await sql`
    update cancellation_survey
      set reasons = ${input.reasons}, note = ${input.note}
    where id = ${input.id} and email = ${input.email}`
}

// Has this email accepted a promotional coupon within the rolling eligibility
// window? Only coupon accepts (coupon_id present) count — plan switches never
// write a coupon-accept row and are never rate-limited (Decision #6). An
// acceptance older than the window no longer blocks a fresh offer.
export async function hasAcceptedRetention(sql: Sql, email: string): Promise<boolean> {
  const rows = await sql`
    select 1 from cancellation_survey
    where email = ${email}
      and offer_outcome = 'accepted'
      and coupon_id is not null
      and created_at >= now() - make_interval(months => ${RETENTION_WINDOW_MONTHS})
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
    // A response matches the reason filter when it named that reason among its
    // (possibly several) checked reasons.
    where.push(`$${params.length} = any(reasons)`)
  }
  let text = `select email, reasons, note, offer_outcome, coupon_id,
      canceled_tier, retained_product, created_at
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
    reasons: (r.reasons as string[] | null) ?? [],
    note: (r.note as string | null) ?? null,
    offerOutcome: r.offer_outcome as string,
    couponId: (r.coupon_id as string | null) ?? null,
    canceledTier: (r.canceled_tier as string | null) ?? null,
    retainedProduct: (r.retained_product as string | null) ?? null,
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
    // Multi-select: unnest so a response counts toward each reason it named.
    sql`select reason, count(*)::int as count
        from cancellation_survey, unnest(reasons) as reason
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
  const headers = [
    'Date', 'Email', 'Outcome', 'Reason', 'Note', 'Coupon', 'Cancelled tier', 'Kept',
  ]
  const body = rows.map((r) => [
    r.createdAt,
    r.email,
    outcomeLabel(r.offerOutcome),
    r.reasons.map((slug) => reasonLabel(slug) ?? slug).join('; '),
    r.note ?? '',
    r.couponId ?? '',
    r.canceledTier ?? '',
    retainedProductLabel(r.retainedProduct) ?? '',
  ])
  return toCsv(headers, body)
}
