// Shared DTOs for the /community subscriber feed.
//
// These are the v1→v2-stable shapes the client UI consumes and the server
// Circle projections produce. They live in shared/ (not src/lib/circle.ts) so
// the Node server can import them without dragging browser-coupled client code
// into its typecheck. src/lib/circle.ts re-exports them for client callers.

/** A read-only feed teaser. Every action on it deep-links into the app. */
export type CommunityFeedItem = {
  id: string
  /** Post title, when the source carries one (Circle space posts do). */
  title?: string
  authorName: string
  authorRole: string
  /** ISO date */
  publishedAt: string
  /** Preview text only — the full body stays in the app. */
  excerpt: string
  /** Deep link that lands the member on this discussion in the app. */
  href: string
}

/**
 * Per-member "since you were last here" digest. v1 always returns null — true
 * unread/reply counts need authenticated per-member reads (v2). The UI hides
 * the digest entirely while this is null.
 */
export type ActivityDigest = {
  /** ISO timestamp of the baseline this digest is measured from. */
  since: string
  newPosts: number
  replies: number
  mentions: number
}

/** A space to suggest in the empty/quiet-feed onboarding nudge. */
export type SuggestedSpace = {
  id: string
  name: string
  /** Optional — Circle's Admin API doesn't return space descriptions. */
  description?: string
  /** Optional — Circle's Admin API doesn't return member counts. */
  memberCount?: number
  /** Deep link that lands the member in this space in the app. */
  href: string
}
