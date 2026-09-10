// Feed-activation mirror.
//
// Beehiiv reports private-feed lifecycle through `podcasts.private_feed`
// webhooks (activated / access_revoked / deactivated). We persist those here to
// power the setup page's status and the reminder cron.
//
// Keyed on the SHOW id, never the feed token: `pod_feed_<uuid>` rotates when a
// feed is reissued, and keying on it would silently reset a member's "set up"
// state. Emails are normalized (lowercased/trimmed) at the boundary so the
// write path (webhook) and read path (/api/me) key on the same value without a
// functional index.
//
// Unlike Supporting Cast, Beehiiv also exposes `activated` on the feed GET, so
// this mirror is no longer the only signal — /api/me folds the live value in
// too, and a missed webhook can't strand the display. What this table uniquely
// holds is the optimistic `pending_at` marker and the bulk read for the cron.

import type { Sql } from './db.js'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Upsert an activation. `activatedAt` is the timestamp Beehiiv reports; null
// when the payload omits it. Re-activating a previously-revoked feed clears
// revoked_at.
export async function recordFeedActivated(
  sql: Sql,
  email: string,
  showId: string,
  activatedAt: string | null,
): Promise<void> {
  await sql`
    insert into beehiiv_feed_activations (email, show_id, activated, activated_at, revoked_at, updated_at)
    values (${normalizeEmail(email)}, ${showId}, true, ${activatedAt}, null, now())
    on conflict (email, show_id) do update set
      activated    = true,
      activated_at = coalesce(${activatedAt}, beehiiv_feed_activations.activated_at),
      revoked_at   = null,
      updated_at   = now()`
}

// Mark a feed's access revoked. Keeps the row (with its original activated_at)
// so we retain history and don't re-nudge someone who deliberately lapsed.
export async function recordFeedRevoked(
  sql: Sql,
  email: string,
  showId: string,
  revokedAt: string | null,
): Promise<void> {
  await sql`
    insert into beehiiv_feed_activations (email, show_id, activated, activated_at, revoked_at, updated_at)
    values (${normalizeEmail(email)}, ${showId}, false, null, ${revokedAt}, now())
    on conflict (email, show_id) do update set
      activated  = false,
      revoked_at = coalesce(${revokedAt}, now()),
      updated_at = now()`
}

// Optimistically mark feeds as set up: the member took a setup action (opened a
// deep link, copied the URL, emailed themselves the link, or handed off to
// Spotify) but the authoritative webhook may lag by minutes. Recording
// `pending_at` lets /api/me show the feed as set up immediately and across
// devices. Never downgrades a confirmed activation: `activated`/`activated_at`
// are left untouched, and `pending_at` is only stamped once (coalesce keeps the
// first). A brand-new row is inserted as not-yet-activated.
export async function recordFeedsPending(
  sql: Sql,
  email: string,
  showIds: string[],
): Promise<void> {
  if (showIds.length === 0) return
  const norm = normalizeEmail(email)
  const emails = showIds.map(() => norm)
  await sql`
    insert into beehiiv_feed_activations (email, show_id, activated, pending_at, updated_at)
    select email, show_id, false, now(), now() from unnest(
      ${emails}::text[],
      ${showIds}::text[]
    ) as t(email, show_id)
    on conflict (email, show_id) do update set
      pending_at = coalesce(beehiiv_feed_activations.pending_at, now()),
      updated_at = now()`
}

// Per-show setup state: `activated` = confirmed by the webhook; `pending` = the
// member took a setup action but the webhook hasn't landed yet. A revoked feed
// reports neither.
export type FeedSetupState = {
  activated: boolean
  activatedAt: string | null
  pending: boolean
}

// Setup state keyed by show id: every show that is either confirmed-activated
// OR optimistically pending. A show with only a stale pending marker on a
// revoked row is treated as not set up. Distinct from getActivatedFeeds (which
// the reminder cron uses) so an unconfirmed pending feed still gets nudged.
export async function getSetupStates(
  sql: Sql,
  email: string,
): Promise<Map<string, FeedSetupState>> {
  const rows = (await sql`
    select show_id, activated, activated_at, pending_at, revoked_at
    from beehiiv_feed_activations
    where email = ${normalizeEmail(email)}
      and (activated = true or pending_at is not null)`) as Array<{
    show_id: string
    activated: boolean
    activated_at: string | null
    pending_at: string | null
    revoked_at: string | null
  }>
  const map = new Map<string, FeedSetupState>()
  for (const r of rows) {
    const activated = r.activated === true
    const pending = !activated && r.pending_at != null && r.revoked_at == null
    if (!activated && !pending) continue
    map.set(r.show_id, {
      activated,
      activatedAt: r.activated_at,
      pending,
    })
  }
  return map
}

// Which of the given emails have at least one currently-activated feed. Powers
// the admin member directory's activation column/filter. Emails are normalized
// to match how activations are stored; the returned set holds the normalized
// forms (callers normalize their lookup key too).
export async function getActivatedEmails(
  sql: Sql,
  emails: string[],
): Promise<Set<string>> {
  const norm = emails.map(normalizeEmail)
  if (norm.length === 0) return new Set()
  const rows = (await sql`
    select distinct email from beehiiv_feed_activations
    where activated = true and email = any(${norm}::text[])`) as Array<{
    email: string
  }>
  return new Set(rows.map((r) => r.email))
}

// All currently-activated shows for an email, keyed by show id. Only rows with
// activated = true are returned; a revoked feed is absent.
export async function getActivatedFeeds(
  sql: Sql,
  email: string,
): Promise<Map<string, string | null>> {
  const rows = (await sql`
    select show_id, activated_at
    from beehiiv_feed_activations
    where email = ${normalizeEmail(email)} and activated = true`) as Array<{
    show_id: string
    activated_at: string | null
  }>
  const map = new Map<string, string | null>()
  for (const r of rows) map.set(r.show_id, r.activated_at)
  return map
}
