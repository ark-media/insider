// Cancellation-survey shape, shared by the client stepper and the server
// validation so the reason list can't drift between them. Store the slug,
// render the label.

export type CancellationReason = {
  slug: string
  label: string
}

// Every reason slug a survey can store, with its label. One map so a slug that
// appears in more than one survey (price, cutting back, other) reads the same
// wherever it surfaces — the survey itself, the admin table, the CSV. The order
// here is the admin filter's display order: Ark+ reasons, Fold reasons, then the
// ones every survey asks.
const REASON_LABELS = {
  finished_series:
    'I subscribed for specific episodes or a series and finished them.',
  not_listening: "I'm not listening regularly.",
  content_mismatch: "The content or topics weren't what I expected.",
  support_only:
    "I subscribed mainly to support Ark Media and don't need an ongoing subscription",
  technical_issues: 'I had trouble accessing the content or using my podcast app.',
  fold_low_usage: "I wasn't spending enough time in The Fold.",
  fold_no_connection:
    'It was hard to find people or conversations I connected with.',
  fold_overwhelming: 'There was too much going on to keep up with.',
  fold_technical_issues:
    'I had trouble with the app, login, or accessing the community.',
  fold_culture_mismatch:
    "The conversations or community culture weren't the right fit for me.",
  too_expensive: "It's too expensive for me right now.",
  cutting_back: "I'm cutting back on subscriptions.",
  other: 'Other (please tell us more).',
} as const

type ReasonSlug = keyof typeof REASON_LABELS

// Build a survey's reason list from slugs, so each survey states its own display
// order (the shared reasons sit in a different place in each) without restating
// any label.
function reasons(...slugs: ReasonSlug[]): readonly CancellationReason[] {
  return slugs.map((slug) => ({ slug, label: REASON_LABELS[slug] }))
}

// Every known reason, in admin display order. This is the validation set (any
// survey's slug is valid on any submit) and the admin filter's option list.
export const CANCELLATION_REASONS: readonly CancellationReason[] = reasons(
  ...(Object.keys(REASON_LABELS) as ReasonSlug[]),
)

const REASON_SLUGS: ReadonlySet<string> = new Set(
  CANCELLATION_REASONS.map((r) => r.slug),
)

// One block of checkboxes. `question` is the sub-question above it, or null for
// the block that follows the survey's prompt directly (every survey opens with
// one of those; only the bundle adds per-product sub-questions after it).
type CancellationSurveyGroup = {
  question: string | null
  reasons: readonly CancellationReason[]
}

// A post-cancel survey: what the member just cancelled, and what we ask about
// it. The survey is multi-select (checkboxes) across all of its groups, so a
// member can pick several; `other` pairs with the free-text note.
export type CancellationSurvey = {
  heading: string
  prompt: string
  groups: readonly CancellationSurveyGroup[]
}

// The prompt is the same in all three surveys.
const SURVEY_PROMPT = "Help us improve by letting us know why you're cancelling."

// Keyed by the tier the member cancelled: Ark+ and the Fold each ask about the
// one product, the bundle asks the shared reasons once and then splits the
// product-specific ones under their own sub-questions. Debundles (dropping one
// half of a bundle) never reach a survey.
export const CANCELLATION_SURVEYS: Record<
  'ark-plus' | 'circle' | 'bundle',
  CancellationSurvey
> = {
  'ark-plus': {
    heading: 'Your Ark+ subscription has been cancelled',
    prompt: SURVEY_PROMPT,
    groups: [
      {
        question: null,
        reasons: reasons(
          'finished_series',
          'not_listening',
          'too_expensive',
          'cutting_back',
          'content_mismatch',
          'support_only',
          'technical_issues',
          'other',
        ),
      },
    ],
  },
  circle: {
    heading: 'Your subscription to The Fold has been cancelled',
    prompt: SURVEY_PROMPT,
    groups: [
      {
        question: null,
        reasons: reasons(
          'fold_low_usage',
          'too_expensive',
          'cutting_back',
          'fold_no_connection',
          'fold_overwhelming',
          'fold_technical_issues',
          'fold_culture_mismatch',
          'other',
        ),
      },
    ],
  },
  bundle: {
    heading: 'Your subscription has been cancelled',
    prompt: SURVEY_PROMPT,
    groups: [
      {
        question: null,
        reasons: reasons('too_expensive', 'cutting_back', 'other'),
      },
      {
        question: 'What made you decide to cancel Ark+?',
        reasons: reasons(
          'finished_series',
          'not_listening',
          'content_mismatch',
          'support_only',
          'technical_issues',
        ),
      },
      {
        question: 'What made you decide to cancel The Fold?',
        reasons: reasons(
          'fold_low_usage',
          'fold_no_connection',
          'fold_overwhelming',
          'fold_technical_issues',
          'fold_culture_mismatch',
        ),
      },
    ],
  },
}

// The slug whose selection means "see my free-text note for the real reason".
export const OTHER_REASON_SLUG = 'other'

export function isCancellationReason(slug: unknown): slug is string {
  return typeof slug === 'string' && REASON_SLUGS.has(slug)
}

// The survey is multi-select: a member submits zero or more reason slugs. Valid
// when it's an array of known slugs (empty is allowed — the survey is optional
// and shown after the cancel already committed). Rejects any unknown slug so a
// crafted body can't store junk.
export function isCancellationReasons(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isCancellationReason)
}

// Terminal outcomes of the cancel flow, persisted in cancellation_survey.
//   not_offered → no retention offer shown; member cancelled.
//   declined    → offer shown, declined; member cancelled.
//   accepted    → offer accepted; no cancel (written by the accept endpoint).
export type OfferOutcome = 'accepted' | 'declined' | 'not_offered'

// The two outcomes the cancel endpoint accepts from the client. 'accepted' is
// written only server-side by accept-save-offer, never sent on a cancel.
const CANCEL_OUTCOMES: ReadonlySet<string> = new Set(['declined', 'not_offered'])

export function isCancelOfferOutcome(v: unknown): v is 'declined' | 'not_offered' {
  return typeof v === 'string' && CANCEL_OUTCOMES.has(v)
}

// Human labels for the stored offer_outcome values. Shared so the admin table,
// the filter controls, and the server-rendered CSV all read the same way.
const OFFER_OUTCOME_LABEL: Record<OfferOutcome, string> = {
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
  return REASON_LABELS[slug as ReasonSlug] ?? slug
}

// What the member was left with after a cancel/debundle, recorded on the
// cancellation row for win-back targeting (joined to beehiiv_subscription by
// email). Independent of whether the membership row is later deleted.
//   full-exit     → cancelled everything (Flows A / B / E full cancel)
//   kept-circle   → debundled, kept the Fold, dropped Ark+ (Flow C)
//   kept-ark-plus → debundled, kept Ark+, dropped the Fold (Flow D)
export type RetainedProduct = 'full-exit' | 'kept-circle' | 'kept-ark-plus'

const RETAINED_PRODUCTS: ReadonlySet<string> = new Set([
  'full-exit',
  'kept-circle',
  'kept-ark-plus',
])

export function isRetainedProduct(v: unknown): v is RetainedProduct {
  return typeof v === 'string' && RETAINED_PRODUCTS.has(v)
}

const RETAINED_PRODUCT_LABEL: Record<RetainedProduct, string> = {
  'full-exit': 'Full cancel',
  'kept-circle': 'Debundled — kept the Fold',
  'kept-ark-plus': 'Debundled — kept Ark+',
}

export function retainedProductLabel(v: string | null): string | null {
  if (!v) return null
  return RETAINED_PRODUCT_LABEL[v as RetainedProduct] ?? v
}

// --- Admin cancellations view (GET /api/admin/cancellations) -------------

export type CancellationRow = {
  email: string
  // Multi-select: the reason slugs the member checked (empty for an accept row,
  // or when a cancel's survey was skipped).
  reasons: string[]
  note: string | null
  offerOutcome: string
  couponId: string | null
  // The tier that was cancelled/debundled from, and what the member kept. Null
  // on older rows written before 0012 and on accept rows (a stay, not a cancel).
  canceledTier: string | null
  retainedProduct: string | null
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
