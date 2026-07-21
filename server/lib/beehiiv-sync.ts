// Beehiiv subscription sync.
//
// Source of truth: Beehiiv. We mirror the subscription record into Neon so
// `/account/newsletters` can render preferences without a round-trip and so
// the inbound webhook has a place to land updates (a reader clicks the
// unsubscribe link in an email → Beehiiv updates → webhook tells us).
//
// One publication, two newsletter "surfaces": `ark-daily` (free issues) and
// `members-letter` (premium issues, same publication, premium audience). A
// reader has at most one subscription record per email. We express the two
// surfaces as:
//   - status = active|pending|... → the reader gets emails at all
//   - has_premium                 → the reader gets the members-letter issues
//
// Callers:
//   - activation.ts (subscription + gift)        → ensureSubscribedWithPremium
//   - stripe.ts webhook (cancel/delete)          → downgradeToFree
//   - entitlement.ts reconciler (downgrade pass) → downgradeToFree
//   - /api/me/newsletters PUT                    → applyPreferences
//   - /api/beehiiv/webhook                       → persistFromBeehiiv +
//                                                  deleteLocalSubscription
//
// All push paths soft-fail with a logged error — the SC subscription / Auth0
// patch / Stripe webhook ack should never 500 because Beehiiv burped.

import { makeTTLCache } from '../../shared/ttl-cache.js'
import { redactEmail } from '../../shared/validation.js'
import type { Sql } from './db.js'

// Beehiiv statuses where the reader is still on the list (not fully unsubscribed).
const RECEIVING_EMAIL_STATUSES = new Set(['active', 'pending'])

export function isReceivingEmails(status: string): boolean {
  return RECEIVING_EMAIL_STATUSES.has(status)
}

// Dedupe concurrent GET /api/me/newsletters refreshes on one instance.
const REFRESH_CACHE_TTL_MS = 45_000
type RefreshCacheEntry = { row: LocalSubscriptionRow | null }
const refreshCache = makeTTLCache<string, RefreshCacheEntry>(
  REFRESH_CACHE_TTL_MS,
)

export function invalidateNewsletterRefreshCache(email: string): void {
  refreshCache.delete(email.toLowerCase())
}

export function setNewsletterRefreshCache(
  email: string,
  row: LocalSubscriptionRow | null,
): void {
  refreshCache.set(email.toLowerCase(), { row })
}

/** Resets the process-global refresh cache (unit tests only). */
export function clearNewsletterRefreshCache(): void {
  refreshCache.clear()
}

type Env = Record<string, string>

// --- Beehiiv API client ---------------------------------------------------

// Shape returned by Beehiiv's subscription endpoints. We narrow this at the
// API boundary (`unwrapData`) into the stricter `BeehiivSubscription` so
// downstream code doesn't need to re-check id/email.
type BeehiivApiResponse = {
  data?: {
    id?: string
    email?: string
    status?: string
    subscription_tier?: 'free' | 'premium'
    subscription_premium_tier_names?: string[]
  }
}

export type BeehiivSubscription = {
  id: string
  email: string
  status: string
  hasPremium: boolean
}

function inferHasPremium(data: NonNullable<BeehiivApiResponse['data']>): boolean {
  if (data.subscription_tier === 'premium') return true
  return (data.subscription_premium_tier_names ?? []).length > 0
}

function unwrapData(
  body: BeehiivApiResponse,
  op: string,
): BeehiivSubscription {
  const d = body.data
  if (!d?.id) throw new Error(`Beehiiv ${op}: response missing id`)
  if (!d.email) throw new Error(`Beehiiv ${op}: response missing email`)
  return {
    id: d.id,
    email: d.email,
    status: d.status ?? 'active',
    hasPremium: inferHasPremium(d),
  }
}

function publicationIdFromEnv(env: Env): string | null {
  // The two slug-scoped vars point at the same shared publication (see
  // server/routes/beehiiv.ts and .env). We accept either as the source of
  // truth and prefer ark-daily as a tie-breaker.
  const id =
    env.BEEHIIV_PUBLICATION_ID_ARK_DAILY ||
    env.BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER
  if (!id || !/^pub_[A-Za-z0-9-]+$/.test(id)) return null
  return id
}

function beehiivHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'content-type': 'application/json',
  }
}

async function getSubscriptionByEmail(
  publicationId: string,
  token: string,
  email: string,
): Promise<BeehiivSubscription | null> {
  const url = `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`
  const res = await fetch(url, { headers: beehiivHeaders(token) })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Beehiiv lookup ${res.status}: ${await res.text()}`)
  }
  return unwrapData((await res.json()) as BeehiivApiResponse, 'lookup')
}

type CreateBody = {
  email: string
  reactivate_existing: true
  utm_source: string
  premium_tier_ids?: string[]
}

async function createSubscription(
  publicationId: string,
  token: string,
  email: string,
  opts: { premiumTierId?: string } = {},
): Promise<BeehiivSubscription> {
  const body: CreateBody = {
    email,
    // Re-subscribe readers who previously unsubscribed instead of erroring
    // (matches the public /api/beehiiv/subscribe behavior).
    reactivate_existing: true,
    utm_source: opts.premiumTierId ? 'insider-membership' : 'insider-site',
  }
  if (opts.premiumTierId) body.premium_tier_ids = [opts.premiumTierId]
  const res = await fetch(
    `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions`,
    {
      method: 'POST',
      headers: beehiivHeaders(token),
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    throw new Error(`Beehiiv create ${res.status}: ${await res.text()}`)
  }
  return unwrapData((await res.json()) as BeehiivApiResponse, 'create')
}

type UpdateBody = {
  tier?: 'free' | 'premium'
  premium_tier_ids?: string[]
  unsubscribe?: boolean
}

async function updateSubscription(
  publicationId: string,
  token: string,
  subscriptionId: string,
  body: UpdateBody,
): Promise<BeehiivSubscription> {
  const res = await fetch(
    `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions/${subscriptionId}`,
    {
      method: 'PUT',
      headers: beehiivHeaders(token),
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    throw new Error(`Beehiiv update ${res.status}: ${await res.text()}`)
  }
  return unwrapData((await res.json()) as BeehiivApiResponse, 'update')
}

// --- Local DB mirror ------------------------------------------------------

export type LocalSubscriptionRow = {
  email: string
  publicationId: string
  beehiivSubscriptionId: string
  status: string
  hasPremium: boolean
  updatedAt: string
}

type Row = Record<string, unknown>

function mapRow(r: Row): LocalSubscriptionRow {
  return {
    email: String(r.email),
    publicationId: String(r.publication_id),
    beehiivSubscriptionId: String(r.beehiiv_subscription_id),
    status: String(r.status),
    hasPremium: Boolean(r.has_premium),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  }
}

// Pull the reader's live Beehiiv record into Neon so GET preferences reflect
// upstream state (signup via site, Beehiiv UI, or a stale mirror).
export async function refreshSubscriptionFromBeehiiv(
  deps: PushDeps,
  email: string,
): Promise<LocalSubscriptionRow | null> {
  const cfg = beehiivConfigured(deps.env)
  const normalized = email.toLowerCase()
  if (!cfg) return getLocalSubscription(deps.sql, normalized)

  const cached = refreshCache.get(normalized)
  if (cached) return cached.row

  try {
    const sub = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)
    if (!sub) {
      await deleteLocalSubscription(deps.sql, normalized)
      refreshCache.set(normalized, { row: null })
      return null
    }
    await persistFromBeehiiv(deps.sql, cfg.pubId, sub)
    const row = await getLocalSubscription(deps.sql, normalized)
    refreshCache.set(normalized, { row })
    return row
  } catch (err) {
    console.error(
      `[beehiiv-sync] refresh failed for ${redactEmail(email)}:`,
      err,
    )
    return getLocalSubscription(deps.sql, normalized)
  }
}

export async function getLocalSubscription(
  sql: Sql,
  email: string,
): Promise<LocalSubscriptionRow | null> {
  const rows = (await sql`
    select email, publication_id, beehiiv_subscription_id, status,
           has_premium, updated_at
    from beehiiv_subscription
    where email = ${email.toLowerCase()}
    limit 1
  `) as Row[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function upsertLocalSubscription(
  sql: Sql,
  input: Omit<LocalSubscriptionRow, 'updatedAt'>,
): Promise<void> {
  await sql`
    insert into beehiiv_subscription
      (email, publication_id, beehiiv_subscription_id, status, has_premium, updated_at)
    values
      (${input.email.toLowerCase()}, ${input.publicationId}, ${input.beehiivSubscriptionId},
       ${input.status}, ${input.hasPremium}, now())
    on conflict (email) do update set
      publication_id = excluded.publication_id,
      beehiiv_subscription_id = excluded.beehiiv_subscription_id,
      status = excluded.status,
      has_premium = excluded.has_premium,
      updated_at = now()
  `
}

export async function deleteLocalSubscription(
  sql: Sql,
  email: string,
): Promise<void> {
  await sql`delete from beehiiv_subscription where email = ${email.toLowerCase()}`
}

// Single projection from Beehiiv subscription to a local DB row. Used by
// every push helper here and the inbound webhook handler — keeps the
// projection in one place so a Beehiiv field rename ripples to one site.
export async function persistFromBeehiiv(
  sql: Sql,
  publicationId: string,
  sub: BeehiivSubscription,
): Promise<void> {
  await upsertLocalSubscription(sql, {
    email: sub.email,
    publicationId,
    beehiivSubscriptionId: sub.id,
    status: sub.status,
    hasPremium: sub.hasPremium,
  })
}

// --- Push operations ------------------------------------------------------

export type PushDeps = {
  env: Env
  sql: Sql
}

function beehiivConfigured(env: Env): { pubId: string; token: string } | null {
  const token = env.BEEHIIV_API_KEY
  const pubId = publicationIdFromEnv(env)
  if (!token || !pubId) return null
  return { pubId, token }
}

// First-login auto-subscribe for a new free Auth0 account. Idempotent on
// three layers:
//   1. Local Neon mirror — if we already have a row, skip entirely (no
//      Beehiiv round-trip, no upsert).
//   2. Beehiiv's per-publication by_email lookup inside applyPreferences
//      finds any pre-existing subscription and falls back to a PUT instead
//      of a duplicate POST.
//   3. createSubscription sends reactivate_existing:true so even a racing
//      POST won't error.
// Soft-fails: callers must keep returning 200 if Beehiiv is unreachable,
// otherwise a third-party blip would block account login.
export async function ensureFreeSubscription(
  deps: PushDeps,
  email: string,
): Promise<void> {
  if (!beehiivConfigured(deps.env)) return
  const existing = await getLocalSubscription(deps.sql, email.toLowerCase())
  if (existing) return
  await tryPush('first-login subscribe', async () => {
    await applyPreferences(deps, email, { free: true })
  })
}

// Subscribe (or upgrade) a reader to the premium tier. Used on Stripe sub
// activation and gift redemption. Idempotent: re-running for an already-
// premium-and-active reader skips the upstream PUT.
export async function ensureSubscribedWithPremium(
  deps: PushDeps,
  email: string,
): Promise<void> {
  const cfg = beehiivConfigured(deps.env)
  if (!cfg) return
  const premiumTierId = deps.env.BEEHIIV_PREMIUM_TIER_ID
  if (!premiumTierId) {
    console.error('[beehiiv-sync] BEEHIIV_PREMIUM_TIER_ID not set; cannot upgrade')
    return
  }

  const normalized = email.toLowerCase()
  const existing = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)

  let result: BeehiivSubscription
  if (!existing) {
    result = await createSubscription(cfg.pubId, cfg.token, normalized, {
      premiumTierId,
    })
  } else if (!existing.hasPremium || existing.status === 'inactive') {
    // Either missing the tier or dormant. A PUT with premium_tier_ids
    // applies the tier and re-activates the record in one shot.
    result = await updateSubscription(cfg.pubId, cfg.token, existing.id, {
      premium_tier_ids: [premiumTierId],
    })
  } else {
    result = existing
  }
  await persistFromBeehiiv(deps.sql, cfg.pubId, result)
}

// Downgrade a reader to free (keep them on the list, just drop premium).
// Used on Stripe sub cancel/delete and the reconciler downgrade pass.
export async function downgradeToFree(
  deps: PushDeps,
  email: string,
): Promise<void> {
  const cfg = beehiivConfigured(deps.env)
  if (!cfg) return
  const normalized = email.toLowerCase()
  const existing = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)
  if (!existing) return
  const next = existing.hasPremium
    ? await updateSubscription(cfg.pubId, cfg.token, existing.id, {
        tier: 'free',
      })
    : existing
  await persistFromBeehiiv(deps.sql, cfg.pubId, next)
}

// Apply both toggles in one Beehiiv round-trip. `free` and `premium` are the
// desired final states; either may be omitted to leave that dimension alone.
// The caller is responsible for verifying entitlement before passing
// `premium: true` — this helper does not check.
//
// One shared publication = one record. Toggle semantics:
//   free=true  → status active (re-subscribe if needed). If `premium` was
//                not specified and the existing record had premium, the
//                tier is preserved (subject to Beehiiv's own behavior on
//                re-activation).
//   free=false → unsubscribe the whole record; premium issues stop too
//                (UI copy makes this explicit).
//   premium=true  → apply premium tier
//   premium=false → tier 'free' (downgrade, do not unsubscribe)
export type PreferenceInput = { free?: boolean; premium?: boolean }

// Thrown when a caller asks to enable premium but no premium tier is configured
// for the publication (BEEHIIV_PREMIUM_TIER_ID unset). Distinct from a transient
// Beehiiv failure so the route can return a specific status instead of pretending
// the change landed.
export class PremiumNotConfiguredError extends Error {
  constructor() {
    super('BEEHIIV_PREMIUM_TIER_ID not set; cannot enable premium')
    this.name = 'PremiumNotConfiguredError'
  }
}

export async function applyPreferences(
  deps: PushDeps,
  email: string,
  prefs: PreferenceInput,
): Promise<LocalSubscriptionRow | null> {
  const cfg = beehiivConfigured(deps.env)
  if (!cfg) return null
  if (prefs.free === undefined && prefs.premium === undefined) {
    return getLocalSubscription(deps.sql, email.toLowerCase())
  }

  const premiumTierId = deps.env.BEEHIIV_PREMIUM_TIER_ID
  if (prefs.premium === true && !premiumTierId) {
    // Surface this instead of silently returning the unchanged row — otherwise
    // the route responds 200 and the toggle looks like it worked when it didn't.
    throw new PremiumNotConfiguredError()
  }

  const normalized = email.toLowerCase()
  const existing = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)

  // Build a combined update body so we hit Beehiiv at most once for both
  // toggles. `unsubscribe`/tier fields are only set when the caller asked.
  const body: UpdateBody = {}
  if (prefs.free === true) body.unsubscribe = false
  if (prefs.free === false) body.unsubscribe = true
  if (prefs.premium === true && premiumTierId) {
    body.premium_tier_ids = [premiumTierId]
  }
  if (prefs.premium === false) body.tier = 'free'

  let result: BeehiivSubscription | null
  if (!existing) {
    // No upstream record. Only make sense to create when `free: true` or
    // `premium: true`; a "turn off" against a non-existent record is a no-op.
    if (prefs.free === false || prefs.premium === false) {
      return null
    }
    result = await createSubscription(cfg.pubId, cfg.token, normalized, {
      premiumTierId: prefs.premium === true ? premiumTierId : undefined,
    })
  } else if (prefs.free === true && !isReceivingEmails(existing.status)) {
    // Re-subscribing a churned record. Beehiiv's PUT `unsubscribe:false` does
    // NOT reactivate an `inactive`/unsubscribed subscription — only the create
    // endpoint with `reactivate_existing:true` flips it back to `active`. Carry
    // the premium tier through the reactivation: keep an existing premium tier
    // unless the caller is explicitly turning premium off.
    const keepPremium =
      prefs.premium === true || (prefs.premium === undefined && existing.hasPremium)
    result = await createSubscription(cfg.pubId, cfg.token, normalized, {
      premiumTierId: keepPremium ? premiumTierId : undefined,
    })
    // An explicit premium downgrade requested alongside reactivation: apply it
    // in a follow-up PUT (create can't express tier=free).
    if (prefs.premium === false) {
      result = await updateSubscription(cfg.pubId, cfg.token, result.id, {
        tier: 'free',
      })
    }
  } else {
    result = await updateSubscription(cfg.pubId, cfg.token, existing.id, body)
  }
  await persistFromBeehiiv(deps.sql, cfg.pubId, result)
  const row = await getLocalSubscription(deps.sql, normalized)
  setNewsletterRefreshCache(normalized, row)
  return row
}

// Soft-fail wrapper for activation / webhook paths. Logs and swallows so an
// SC provisioning success / Stripe webhook ack isn't blocked by a Beehiiv
// hiccup. Return value indicates whether the call landed cleanly.
export async function tryPush(
  label: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    console.error(`[beehiiv-sync] ${label} failed:`, err)
    return false
  }
}
