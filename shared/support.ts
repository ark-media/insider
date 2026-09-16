// Client/server contract for the help widget's session log.
//
// One record per widget session, holding an ordered list of what the member
// did. The point of the log is not the transcript — it is the set of queries
// that returned nothing, which is the backlog for /admin/faqs.

/** What happened at one step of a session. */
export type SupportStepKind =
  /** The member picked a topic chip. `value` is the topic id. */
  | 'topic'
  /** The member typed a search. `value` is the query. */
  | 'query'
  /** A search returned nothing usable. `value` is the query. */
  | 'no_results'
  /** The corpus provably can't answer this. `value` is the intent. */
  | 'unanswerable'
  /** An answer was expanded. `value` is the FAQ key (or id when unkeyed). */
  | 'faq_opened'
  /** A link or action was followed. `value` is the destination. */
  | 'link'
  /** The member asked for a person. `value` is the contact topic. */
  | 'escalate'

export type SupportStep = {
  /** ISO timestamp, set by the client when the step happened. */
  at: string
  kind: SupportStepKind
  value: string
}

/** What the widget POSTs to /api/support/log. */
export type SupportSessionInput = {
  sessionId: string
  steps: SupportStep[]
}

/** What /api/admin/support-conversations returns. */
export type SupportSession = {
  id: string
  sessionId: string
  /** Server-derived from the session cookie; null for a signed-out visitor. */
  email: string | null
  steps: SupportStep[]
  escalated: boolean
  createdAt: string
  updatedAt: string
}

export const SUPPORT_STEP_KINDS: SupportStepKind[] = [
  'topic', 'query', 'no_results', 'unanswerable', 'faq_opened', 'link', 'escalate',
]

/** Caps enforced on both sides, so the client can't grow a row without bound. */
export const SUPPORT_MAX_STEPS = 50
export const SUPPORT_MAX_VALUE_LENGTH = 500
export const SUPPORT_MAX_SESSION_ID_LENGTH = 64
