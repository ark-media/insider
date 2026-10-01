// Beehiiv subscription sync.
//
// Source of truth: Beehiiv. We mirror the subscription record into Neon so
// `/account/newsletters` can render preferences without a round-trip and so
// the inbound webhook has a place to land updates (a reader clicks the
// unsubscribe link in an email → Beehiiv updates → webhook tells us).
//
// One publication, one newsletter, two editions: free readers get the free
// edition, premium-tier readers the members' edition of the same issue. A
// reader has at most one subscription record per email:
//   - status = active|pending|... → the reader gets the newsletter at all
//   - has_premium                 → which edition (and, separately, the
//                                   private podcast feed — see below)
//
// Callers:
//   - activation.ts (subscription + gift)        → ensureSubscribedWithPremium
//   - stripe.ts webhook (cancel/delete)          → downgradeToFree
//   - entitlement.ts reconciler (downgrade pass) → downgradeToFree
//   - /api/me/newsletters PUT                    → applyPreferences
//   - /api/beehiiv/webhook                       → persistFromBeehiiv +
//                                                  deleteLocalSubscription
//
// All push paths soft-fail with a logged error — the feed grant / Auth0
// patch / Stripe webhook ack should never 500 because Beehiiv burped.

import { makeTTLCache } from '../../shared/ttl-cache.js'
import { redactEmail } from '../../shared/validation.js'
import { publicationIdFromEnv } from './beehiiv-feeds.js'
import type { Sql } from './db.js'
import { fetchWithTimeout } from "./http.js"

// Beehiiv statuses where the reader is still on the list (not fully unsubscribed).
const RECEIVING_EMAIL_STATUSES = new Set(['active', 'pending'])

export function isReceivingEmails(status: string): boolean {
  return RECEIVING_EMAIL_STATUSES.has(status)
}

// Dedupe concurrent GET /api/me/newsletters refreshes on one instance.
const REFRESH_CACHE_TTL_MS = 45_000
type RefreshCacheEntry = {
  row: LocalSubscriptionRow | null
  amaOptIn: boolean | null
}
const refreshCache = makeTTLCache<string, RefreshCacheEntry>(
  REFRESH_CACHE_TTL_MS,
)

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
    // Only present when the request asked for `expand[]=custom_fields`.
    custom_fields?: Array<{ name?: string; value?: unknown }>
  }
}

export type BeehiivSubscription = {
  id: string
  email: string
  status: string
  hasPremium: boolean
  /**
   * The AMA opt-in custom field. Undefined when the response didn't carry
   * custom fields at all (webhook payloads, PUT bodies without the expand) —
   * which is not the same as the reader having said no.
   */
  amaOptIn?: boolean
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
  const sub: BeehiivSubscription = {
    id: d.id,
    email: d.email,
    status: d.status ?? 'active',
    hasPremium: inferHasPremium(d),
  }
  if (d.custom_fields) {
    const field = d.custom_fields.find(
      (f) => (f.name ?? '').toLowerCase() === FIELD_AMA_OPT_IN.toLowerCase(),
    )
    sub.amaOptIn = field?.value === true || field?.value === 'true'
  }
  return sub
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
  // Custom fields are expanded so the AMA opt-in rides the same read.
  const url = `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}?expand[]=custom_fields`
  const res = await fetchWithTimeout(url, { headers: beehiivHeaders(token) })
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
    utm_source: opts.premiumTierId ? 'ark-media-membership' : 'ark-media-website',
  }
  if (opts.premiumTierId) body.premium_tier_ids = [opts.premiumTierId]
  const res = await fetchWithTimeout(
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

// Beehiiv has no native name field — a subscriber's name is a *custom field*,
// and the definition must already exist on the publication or the API silently
// discards the value ("Any new custom fields here will be discarded"). Provision
// them once with scripts/beehiiv-provision-custom-fields.ts; these two strings
// are the contract between that script and every write below.
export const FIELD_FIRST_NAME = 'First Name'
export const FIELD_LAST_NAME = 'Last Name'

// The opt-in for the AMA YouTube-link emails: a boolean custom field on the
// same publication, and the Beehiiv segment "Ark+ AMA YouTube links (opted
// in)" is every subscriber where it equals true. It is a member perk — the
// link is unlisted — so only an arkPlus reader can turn it on
// (/api/me/newsletters) and downgradeToFree turns it off. The segment itself
// can't test the tier (Beehiiv's segment API filters on custom fields only),
// so clearing it on the way out is what keeps a lapsed member off the list.
// Provisioned, with the segment, by scripts/beehiiv-provision-custom-fields.ts.
export const FIELD_AMA_OPT_IN = 'AMA YouTube Links'

type CustomFieldWrite = { name: string; value?: string | boolean; delete?: boolean }

type UpdateBody = {
  tier?: 'free' | 'premium'
  premium_tier_ids?: string[]
  unsubscribe?: boolean
  custom_fields?: CustomFieldWrite[]
}

async function updateSubscription(
  publicationId: string,
  token: string,
  subscriptionId: string,
  body: UpdateBody,
): Promise<BeehiivSubscription> {
  const res = await fetchWithTimeout(
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
  return (await refreshNewsletterState(deps, email)).row
}

// The same refresh, plus the AMA opt-in. The opt-in lives only in Beehiiv (no
// mirror column), so it is null whenever Beehiiv couldn't be read — unknown,
// which the settings UI must not render as "off".
export async function refreshNewsletterState(
  deps: PushDeps,
  email: string,
): Promise<RefreshCacheEntry> {
  const cfg = beehiivConfigured(deps.env)
  const normalized = email.toLowerCase()
  if (!cfg) {
    return { row: await getLocalSubscription(deps.sql, normalized), amaOptIn: null }
  }

  const cached = refreshCache.get(normalized)
  if (cached) return cached

  try {
    const sub = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)
    if (!sub) {
      await deleteLocalSubscription(deps.sql, normalized)
      const entry = { row: null, amaOptIn: false }
      refreshCache.set(normalized, entry)
      return entry
    }
    await persistFromBeehiiv(deps.sql, cfg.pubId, sub)
    const row = await getLocalSubscription(deps.sql, normalized)
    const entry = { row, amaOptIn: sub.amaOptIn ?? false }
    refreshCache.set(normalized, entry)
    return entry
  } catch (err) {
    console.error(
      `[beehiiv-sync] refresh failed for ${redactEmail(email)}:`,
      err,
    )
    return { row: await getLocalSubscription(deps.sql, normalized), amaOptIn: null }
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

async function upsertLocalSubscription(
  sql: Sql,
  input: Omit<LocalSubscriptionRow, 'updatedAt'>,
): Promise<void> {
  // `premium_since` stamps the false → true transition and is then left alone
  // (so it keeps meaning "when they started paying", not "when we last
  // synced"), and is cleared on a downgrade so a re-subscribe re-stamps. It is
  // the reminder cron's join clock — see migrations/0001_initial_schema.sql.
  await sql`
    insert into beehiiv_subscription
      (email, publication_id, beehiiv_subscription_id, status, has_premium, premium_since, updated_at)
    values
      (${input.email.toLowerCase()}, ${input.publicationId}, ${input.beehiivSubscriptionId},
       ${input.status}, ${input.hasPremium},
       case when ${input.hasPremium} then now() else null end, now())
    on conflict (email) do update set
      publication_id = excluded.publication_id,
      beehiiv_subscription_id = excluded.beehiiv_subscription_id,
      status = excluded.status,
      has_premium = excluded.has_premium,
      premium_since = case
        when excluded.has_premium
          then coalesce(beehiiv_subscription.premium_since, now())
        else null
      end,
      updated_at = now()
  `
}

// Every reader currently holding the premium tier, by email. This is the
// reconciler's arkPlus roster: holding the tier is what grants the private
// feed, so a row here is a live grant that must be justified by a live Neon
// membership. Read from the mirror rather than from Beehiiv because Beehiiv has
// no "list premium subscribers" endpoint, and the mirror is kept current by the
// same webhook that drives everything else.
export async function loadPremiumSubscriberEmails(sql: Sql): Promise<string[]> {
  const rows = (await sql`
    select email from beehiiv_subscription where has_premium = true`) as Array<{
    email: string
  }>
  return rows.map((r) => r.email)
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

// Same deps, minus the requirement of a Neon store. Only the premium grant
// takes this shape: it has to run in environments with no DATABASE_URL (the
// webhook's no-DB branch), where every other push has nothing to mirror anyway.
export type GrantDeps = {
  env: Env
  sql: Sql | null
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
  await tryPush('first-login subscribe', () => applyPreferences(deps, email, { free: true }))
}

// Subscribe (or upgrade) a reader to the premium "Plus" tier. Used on Stripe
// sub activation and gift redemption. Idempotent: re-running for an already-
// premium-and-active reader skips the upstream PUT.
//
// This is the arkPlus GRANT, not a newsletter nicety: the premium tier is what
// entitles a member to the private podcast feed, so activation.ts stamps its
// provisioning marker on the strength of this call. Two consequences for the
// contract here:
//
//   - it answers whether the tier actually landed, so a caller can tell "granted"
//     from "Beehiiv isn't configured in this environment" (preview / tests) and
//     only mark the axis provisioned in the first case;
//   - a Beehiiv API failure THROWS rather than being swallowed, so the Stripe
//     webhook retries instead of acking a member into a feedless membership.
//     "Failure" includes a 2xx that did not actually apply the tier: Beehiiv
//     accepts a `premium_tier_ids` naming a tier from another publication and
//     ignores it, so the response is only trustworthy once `hasPremium` is
//     re-read off it. That case throws too (PremiumGrantIgnoredError).
//
// `sql` may be null where there is no Neon store to mirror into — the grant is
// what matters, the local row is a cache of it.
export async function ensureSubscribedWithPremium(
  deps: GrantDeps,
  email: string,
): Promise<boolean> {
  const cfg = beehiivConfigured(deps.env)
  if (!cfg) return false
  const premiumTierId = deps.env.BEEHIIV_PREMIUM_TIER_ID
  // Beehiiv is wired up but has no tier to apply — a misconfiguration, and one
  // that would otherwise present as a member who paid and got nothing. Raise it
  // rather than log-and-continue.
  if (!premiumTierId) throw new PremiumNotConfiguredError()

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
  // Mirror what Beehiiv actually says before judging it — a `has_premium: false`
  // row is the truth, and the record that makes this diagnosable.
  if (deps.sql) await persistFromBeehiiv(deps.sql, cfg.pubId, result)
  // The call returned 2xx but the tier is not on the record. Beehiiv answers
  // 2xx and silently ignores `premium_tier_ids` holding a tier that belongs to
  // a DIFFERENT publication, so a publication/tier mismatch in the environment
  // lands here — indistinguishable, upstream, from success. Without this the
  // function returns true, activation.ts stamps the axis provisioned, and the
  // member is left paying for a feed that was never minted.
  if (!result.hasPremium) {
    throw new PremiumGrantIgnoredError(cfg.pubId, premiumTierId)
  }
  return true
}

// Push a member's name onto their Beehiiv subscriber record so campaigns can
// personalize. Deliberately does NOT create a subscription: a name is not a
// reason to add someone to the list, so a reader with no Beehiiv record is a
// no-op.
//
// A part passed as `null` is *cleared* on the record; `undefined` (or '') leaves
// whatever is there alone. Only the account save can express a deliberate clear
// — a name harvested by the backfill or read off a Stripe customer simply
// doesn't know the surname, which is not the same as knowing there isn't one.
// Without the distinction, a member who deletes their surname keeps it in
// Beehiiv forever and every {{first}} {{last}} merge re-sends it.
//
// Returns whether a write actually reached Beehiiv, so callers reporting counts
// don't tally the no-ops.
export async function syncSubscriberName(
  deps: PushDeps,
  email: string,
  name: { first?: string | null; last?: string | null },
): Promise<boolean> {
  const cfg = beehiivConfigured(deps.env)
  if (!cfg) return false

  const fields: CustomFieldWrite[] = []
  const first = (name.first ?? '').trim()
  if (first) fields.push({ name: FIELD_FIRST_NAME, value: first })
  const last = (name.last ?? '').trim()
  if (last) fields.push({ name: FIELD_LAST_NAME, value: last })
  else if (name.last === null) fields.push({ name: FIELD_LAST_NAME, delete: true })
  if (fields.length === 0) return false

  const normalized = email.toLowerCase()
  const existing = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)
  if (!existing) return false

  await updateSubscription(cfg.pubId, cfg.token, existing.id, {
    custom_fields: fields,
  })
  // Mirror the by_email read, not the update response. This PUT carries only
  // custom_fields, and a response that omits the tier fields makes
  // inferHasPremium answer false — which would write has_premium=false over a
  // paying member and light up the reconciler. Nothing about the subscription
  // itself changed here, so `existing` is still the authoritative picture.
  await persistFromBeehiiv(deps.sql, cfg.pubId, existing)
  return true
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
  // The AMA opt-in goes with the tier, in the same PUT: the segment can't see
  // the tier, so a flag left at true would keep mailing an unlisted link to
  // someone who is no longer a member. Also cleared for a reader already
  // without the tier whose flag is still set (premium removed in Beehiiv's UI).
  const body: UpdateBody = {}
  if (existing.hasPremium) body.tier = 'free'
  if (existing.amaOptIn) {
    body.custom_fields = [{ name: FIELD_AMA_OPT_IN, value: false }]
  }
  const next =
    Object.keys(body).length > 0
      ? await updateSubscription(cfg.pubId, cfg.token, existing.id, body)
      : existing
  await persistFromBeehiiv(deps.sql, cfg.pubId, next)
  refreshCache.delete(normalized)
}

// Thrown when a reader asks for the AMA emails without being on the newsletter
// at all. They share the publication, so an unsubscribed record can't receive
// them — saying so beats storing an opt-in that will never deliver.
export class NewsletterOffError extends Error {
  constructor() {
    super('not subscribed to the publication; AMA emails cannot be delivered')
    this.name = 'NewsletterOffError'
  }
}

// Set or clear the AMA opt-in. The caller checks arkPlus before passing
// `on: true` — this helper does not. Turning it off for a reader with no record
// is a no-op. Returns the opt-in as Beehiiv now holds it.
export async function setAmaOptIn(
  deps: PushDeps,
  email: string,
  on: boolean,
): Promise<boolean> {
  const cfg = beehiivConfigured(deps.env)
  if (!cfg) throw new Error('Beehiiv not configured')
  const normalized = email.toLowerCase()
  const existing = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)
  if (!existing) {
    if (on) throw new NewsletterOffError()
    return false
  }
  if (on && !isReceivingEmails(existing.status)) throw new NewsletterOffError()

  const result = await updateSubscription(cfg.pubId, cfg.token, existing.id, {
    custom_fields: [{ name: FIELD_AMA_OPT_IN, value: on }],
  })
  // Mirror the by_email read, not the response — same reason as
  // syncSubscriberName: a custom-fields-only PUT says nothing about the tier.
  await persistFromBeehiiv(deps.sql, cfg.pubId, existing)
  const amaOptIn = result.amaOptIn ?? on
  const row = await getLocalSubscription(deps.sql, normalized)
  refreshCache.set(normalized, { row, amaOptIn })
  return amaOptIn
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

// Thrown when the premium tier was sent and Beehiiv answered 2xx, but the
// subscription came back WITHOUT it. Distinct from PremiumNotConfiguredError
// (which means the tier id is missing entirely): here the id is present but
// Beehiiv would not apply it — overwhelmingly because it belongs to a different
// publication than the one being written to, i.e. BEEHIIV_PUBLICATION_ID_* and
// BEEHIIV_PREMIUM_TIER_ID disagree. Both ids go in the message because that
// pairing is the diagnosis, and the failure is otherwise invisible: Beehiiv
// reports no error, and the member simply never gets a feed.
export class PremiumGrantIgnoredError extends Error {
  constructor(publicationId: string, premiumTierId: string) {
    super(
      `Beehiiv accepted the request but did not apply premium tier ${premiumTierId} ` +
        `on publication ${publicationId} — do they belong to the same publication?`,
    )
    this.name = 'PremiumGrantIgnoredError'
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
  refreshCache.set(normalized, {
    row,
    amaOptIn: result.amaOptIn ?? existing?.amaOptIn ?? null,
  })
  return row
}

// Soft-fail wrapper for activation / webhook paths. Logs and swallows so an
// provisioning success / Stripe webhook ack isn't blocked by a Beehiiv
// hiccup. Return value indicates whether the call threw, not what it returned —
// pushes like syncSubscriberName answer false for a legitimate no-op, so `fn`
// is typed loosely and its result deliberately discarded.
export async function tryPush(
  label: string,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    console.error(`[beehiiv-sync] ${label} failed:`, err)
    return false
  }
}
