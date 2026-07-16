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

// Record an activation ONLY if we have no row for this (email, feed) yet.
// Unlike recordFeedActivated this never overwrites existing state — it won't
// resurrect a revoked feed or clobber an authoritative activated_at. Used by
// the download-derived signals (backfill + audio.downloaded webhook), where a
// download proves the feed was set up but is weaker than an explicit
// activation/revocation event.
export async function recordFeedActivatedIfAbsent(
  sql: Sql,
  email: string,
  feedId: number,
  activatedAt: string | null,
): Promise<void> {
  await sql`
    insert into sc_feed_activations (email, feed_id, activated, activated_at, revoked_at, updated_at)
    values (${normalizeEmail(email)}, ${feedId}, true, ${activatedAt}, null, now())
    on conflict (email, feed_id) do nothing`
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

export type FeedActivation = { feedId: number; activatedAt: string | null }

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
