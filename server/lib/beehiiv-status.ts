// Which Beehiiv subscription statuses are still worth mailing.
//
// Three campaigns ask this question — the feed-setup reminder, the migration
// check-ins, and the win-back — and they have to agree: a reader who is
// unsubscribed for one is unsubscribed for all of them. It lived as three
// copies of the same Set before, which is exactly the kind of list that drifts
// when a provider adds a status.

import { redactEmail } from '../../shared/validation.js'

const SKIP_STATUSES = new Set([
  'inactive',
  'unsubscribed',
  'needs_attention',
  'invalid',
  'deleted',
  'suspended',
])

/**
 * Is this reader still receiving mail?
 *
 * Unknown and blank statuses fail OPEN (mailable). Beehiiv can add a status we
 * don't know, and treating an unrecognized one as undeliverable would silently
 * stop a whole campaign with no error anywhere — a much worse failure than one
 * email to a reader we should have skipped. Every caller has its own audience
 * gate on top of this.
 */
export function mailableStatus(status: string | null | undefined): boolean {
  if (!status) return true
  return !SKIP_STATUSES.has(status.trim().toLowerCase())
}

/**
 * Mask every email address in an upstream response body before it is logged.
 *
 * Beehiiv's error bodies quote the address they are complaining about, so
 * logging `await res.text()` verbatim puts a reader's address in the function
 * logs. Every Beehiiv call site that logs an upstream body goes through this.
 * Lives here, not in beehiiv-sync/beehiiv-feeds, because this module imports
 * nothing of ours, so every caller can import it without a cycle.
 */
export function redactEmailsInText(text: string): string {
  return text.replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, redactEmail)
}
