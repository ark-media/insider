// Cancellation-survey shape, shared by the client stepper and the server
// validation so the reason list can't drift between them. Store the slug,
// render the label.

export type CancellationReason = {
  slug: string
  label: string
}

// Final list (from the reference screenshot). Order is the display order.
export const CANCELLATION_REASONS: readonly CancellationReason[] = [
  { slug: 'too_expensive', label: 'Too expensive' },
  { slug: 'dont_listen_enough', label: "I don't listen enough" },
  {
    slug: 'technical_issues',
    label: 'I could not access the content or had technical issues',
  },
  { slug: 'unhappy_with_content', label: 'I am not happy with the content' },
  {
    slug: 'benefits_too_limited',
    label: 'The subscriber benefits are too limited',
  },
  {
    slug: 'listened_to_target_episodes',
    label: 'I listened to the specific episodes I signed up for',
  },
] as const

const REASON_SLUGS: ReadonlySet<string> = new Set(
  CANCELLATION_REASONS.map((r) => r.slug),
)

export function isCancellationReason(slug: unknown): slug is string {
  return typeof slug === 'string' && REASON_SLUGS.has(slug)
}

// Terminal outcomes of the cancel flow, persisted in cancellation_survey.
//   not_offered → no retention offer shown; member cancelled.
//   declined    → offer shown, declined; member cancelled.
//   accepted    → offer accepted; no cancel (written by the accept endpoint).
export type OfferOutcome = 'accepted' | 'declined' | 'not_offered'

// The two outcomes the cancel endpoint accepts from the client. 'accepted' is
// written only server-side by accept-retention-offer, never sent on a cancel.
const CANCEL_OUTCOMES: ReadonlySet<string> = new Set(['declined', 'not_offered'])

export function isCancelOfferOutcome(v: unknown): v is 'declined' | 'not_offered' {
  return typeof v === 'string' && CANCEL_OUTCOMES.has(v)
}

// Human labels for the stored offer_outcome values. Shared so the admin table,
// the filter controls, and the server-rendered CSV all read the same way.
export const OFFER_OUTCOME_LABEL: Record<OfferOutcome, string> = {
  accepted: 'Kept (offer accepted)',
  declined: 'Cancelled (offer declined)',
  not_offered: 'Cancelled (no offer)',
}

// Display order for outcome filters/columns (mirrors the cancel funnel).
export const OFFER_OUTCOMES: readonly OfferOutcome[] = [
  'accepted',
  'declined',
  'not_offered',
] as const

export function isOfferOutcome(v: unknown): v is OfferOutcome {
  return typeof v === 'string' && v in OFFER_OUTCOME_LABEL
}

// Resolve a stored outcome to its label (unknown values fall back to the raw
// string, matching reasonLabel's behaviour for retired slugs).
export function outcomeLabel(outcome: string): string {
  return OFFER_OUTCOME_LABEL[outcome as OfferOutcome] ?? outcome
}

// Cap free-text note length before it reaches the DB.
export const MAX_CANCELLATION_NOTE_LEN = 2000

// Resolve a stored reason slug to its display label (slugs that aren't in the
// list — e.g. retired ones — fall back to the raw slug). Null when no reason
// (an accepted row).
export function reasonLabel(slug: string | null): string | null {
  if (!slug) return null
  return CANCELLATION_REASONS.find((r) => r.slug === slug)?.label ?? slug
}

// --- Admin cancellations view (GET /api/admin/cancellations) -------------

export type CancellationRow = {
  email: string
  reason: string | null
  note: string | null
  offerOutcome: string
  couponId: string | null
  createdAt: string
}

export type CancellationSummary = {
  // Counts grouped by outcome (accepted | declined | not_offered) and by reason
  // (accepted rows have no reason, so they're excluded from byReason). These
  // aggregates are always global; only `recent` reflects an active filter.
  byOutcome: { outcome: string; count: number }[]
  byReason: { reason: string; count: number }[]
  recent: CancellationRow[]
}

// Optional filters for the admin cancellations view + CSV export. Both narrow
// the row list; an unset (null/undefined) field means "any".
export type CancellationFilter = {
  outcome?: OfferOutcome | null
  reason?: string | null
}
