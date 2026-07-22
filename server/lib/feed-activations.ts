// Feed-activation mirror. Supporting Cast only tells us a private feed was
// activated through the `feed.activated` webhook — there's no queryable REST
// field — so we persist those events here and read them back to power the
// setup hub's progress count and the reminder cron.
//
// Emails are normalized (lowercased/trimmed) at the boundary so the write path
// (webhook) and read path (/api/me) key on the same value without a functional
// index.

import type { Sql } from './db.js'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Upsert an activation. `activatedAt` is the timestamp SC reports; null when the
// payload omits it. Re-activating a previously-revoked feed clears revoked_at.
export async function recordFeedActivated(
  sql: Sql,
  email: string,
  feedId: number,
  activatedAt: string | null,
): Promise<void> {
  await sql`
    insert into sc_feed_activations (email, feed_id, activated, activated_at, revoked_at, updated_at)
    values (${normalizeEmail(email)}, ${feedId}, true, ${activatedAt}, null, now())
    on conflict (email, feed_id) do update set
      activated    = true,
      activated_at = coalesce(${activatedAt}, sc_feed_activations.activated_at),
      revoked_at   = null,
      updated_at   = now()`
}

// Mark a feed's access revoked. Keeps the row (with its original activated_at)
// so we retain history and don't re-nudge someone who deliberately lapsed.
export async function recordFeedRevoked(
  sql: Sql,
  email: string,
  feedId: number,
  revokedAt: string | null,
): Promise<void> {
  await sql`
    insert into sc_feed_activations (email, feed_id, activated, activated_at, revoked_at, updated_at)
    values (${normalizeEmail(email)}, ${feedId}, false, null, ${revokedAt}, now())
    on conflict (email, feed_id) do update set
      activated  = false,
      revoked_at = coalesce(${revokedAt}, now()),
      updated_at = now()`
}

export type ActivationSeed = {
  email: string
  feedId: number
  activatedAt: string | null
}

// Bulk create-if-absent for the backfill. One unnest insert per chunk so a
// backfill of thousands of (email, feed) pairs is a handful of round-trips, not
// one per row. Emails are normalized here (not just trusted from the caller) so
// a mixed-case address can't slip past the (email, feed_id) primary key and
// create a case-variant duplicate of a webhook-written row. Returns rows
// inserted (existing rows are left untouched by `on conflict do nothing`).
export async function backfillActivations(
  sql: Sql,
  seeds: ActivationSeed[],
  chunkSize = 1000,
): Promise<number> {
  let inserted = 0
  for (let i = 0; i < seeds.length; i += chunkSize) {
    const chunk = seeds.slice(i, i + chunkSize)
    const emails = chunk.map((s) => normalizeEmail(s.email))
    const feedIds = chunk.map((s) => s.feedId)
    const ats = chunk.map((s) => s.activatedAt)
    const rows = (await sql`
      insert into sc_feed_activations (email, feed_id, activated, activated_at)
      select email, feed_id, true, activated_at from unnest(
        ${emails}::text[],
        ${feedIds}::bigint[],
        ${ats}::timestamptz[]
      ) as t(email, feed_id, activated_at)
      on conflict (email, feed_id) do nothing
      returning feed_id`) as unknown[]
    inserted += rows.length
  }
  return inserted
}

// Optimistically mark feeds as set up: the member took a setup action (opened
// a deep link, copied the URL, texted themselves the link, or linked Spotify
// for the whole network) but SC's authoritative `feed.activated` webhook may
// lag by minutes. Recording `pending_at` lets /api/me show the feed as set up
// immediately and across devices, replacing the old client-side localStorage
// marker. Never downgrades a confirmed activation: `activated`/`activated_at`
// are left untouched, and `pending_at` is only stamped once (coalesce keeps
// the first). A brand-new row is inserted as not-yet-activated. Handles the
// single-feed and whole-network cases in one unnest insert.
export async function recordFeedsPending(
  sql: Sql,
  email: string,
  feedIds: number[],
): Promise<void> {
  if (feedIds.length === 0) return
  const norm = normalizeEmail(email)
  const emails = feedIds.map(() => norm)
  await sql`
    insert into sc_feed_activations (email, feed_id, activated, pending_at, updated_at)
    select email, feed_id, false, now(), now() from unnest(
      ${emails}::text[],
      ${feedIds}::bigint[]
    ) as t(email, feed_id)
    on conflict (email, feed_id) do update set
      pending_at = coalesce(sc_feed_activations.pending_at, now()),
      updated_at = now()`
}

export type FeedActivation = { feedId: number; activatedAt: string | null }

// Per-feed setup state for the setup hub: `activated` = confirmed by the
// webhook; `pending` = the member took a setup action but the webhook hasn't
// landed yet. A revoked feed reports neither.
export type FeedSetupState = {
  activated: boolean
  activatedAt: string | null
  pending: boolean
}

// Setup state for the hub, keyed by feed id: every feed that is either
// confirmed-activated OR optimistically pending. A feed with only a stale
// pending marker on a revoked row is treated as not set up. Distinct from
// getActivatedFeeds (which the reminder cron uses) so an unconfirmed pending
// feed still gets nudged.
export async function getSetupStates(
  sql: Sql,
  email: string,
): Promise<Map<number, FeedSetupState>> {
  const rows = (await sql`
    select feed_id, activated, activated_at, pending_at, revoked_at
    from sc_feed_activations
    where email = ${normalizeEmail(email)}
      and (activated = true or pending_at is not null)`) as Array<{
    feed_id: number | string
    activated: boolean
    activated_at: string | null
    pending_at: string | null
    revoked_at: string | null
  }>
  const map = new Map<number, FeedSetupState>()
  for (const r of rows) {
    const activated = r.activated === true
    const pending = !activated && r.pending_at != null && r.revoked_at == null
    if (!activated && !pending) continue
    map.set(Number(r.feed_id), {
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
    select distinct email from sc_feed_activations
    where activated = true and email = any(${norm}::text[])`) as Array<{
    email: string
  }>
  return new Set(rows.map((r) => r.email))
}

// All currently-activated feeds for an email, as a map keyed by feed id. Only
// rows with activated = true are returned; a revoked feed is absent.
export async function getActivatedFeeds(
  sql: Sql,
  email: string,
): Promise<Map<number, string | null>> {
  const rows = (await sql`
    select feed_id, activated_at
    from sc_feed_activations
    where email = ${normalizeEmail(email)} and activated = true`) as Array<{
    feed_id: number | string
    activated_at: string | null
  }>
  const map = new Map<number, string | null>()
  for (const r of rows) {
    // bigint comes back as a string from the driver; coerce to number to match
    // the numeric feed ids the SC feeds endpoint returns.
    map.set(Number(r.feed_id), r.activated_at)
  }
  return map
}
