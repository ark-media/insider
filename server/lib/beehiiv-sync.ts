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
  // The reader's newsletter lists as Beehiiv last reported them; null when
  // Beehiiv couldn't be read (unknown, not "none").
  listIds: string[] | null
}
const refreshCache = makeTTLCache<string, RefreshCacheEntry>(
  REFRESH_CACHE_TTL_MS,
)

/** Resets the process-global refresh cache (unit tests only). */
export function clearNewsletterRefreshCache(): void {
  refreshCache.clear()
}

type Env = Record<string, string>

// --- Newsletter lists -----------------------------------------------------
//
// The publication carries two Beehiiv newsletter lists, and they are
// independent — leaving one never touches the other:
//   - The Current (BEEHIIV_LIST_ID_THE_CURRENT): the newsletter. Auto-subscribe
//     is on in Beehiiv, so every new subscription lands on it.
//   - Ark+ AMA Links (BEEHIIV_LIST_ID_AMA): the unlisted YouTube link to each
//     AMA episode. Opt-in, Ark+ only: /api/me/newsletters checks arkPlus
//     before adding anyone, and downgradeToFree takes them off it when the
//     membership ends. Beehiiv can't restrict a list to a tier, so that pair
//     is the whole gate — never expose this list on a Beehiiv form or
//     preference center.
// Leaving a list is not leaving the publication: the subscription stays
// active (and keeps its premium tier and private feed) on zero lists.
//
// Without BEEHIIV_LIST_ID_THE_CURRENT the newsletter switch falls back to
// subscribing/unsubscribing the whole publication; without BEEHIIV_LIST_ID_AMA
// the AMA switch is unavailable. Both lists are made by
// scripts/beehiiv-provision-newsletter-lists.ts.
type NewsletterListIds = { current: string | null; ama: string | null }

const LIST_ID_RE = /^nl_list_[A-Za-z0-9-]+$/

function newsletterListIds(env: Env): NewsletterListIds {
  const valid = (v: string | undefined) => (v && LIST_ID_RE.test(v) ? v : null)
  return {
    current: valid(env.BEEHIIV_LIST_ID_THE_CURRENT),
    ama: valid(env.BEEHIIV_LIST_ID_AMA),
  }
}

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
    // Only present when the request asked for `expand[]=newsletter_lists`.
    newsletter_list_ids?: string[]
  }
}

export type BeehiivSubscription = {
  id: string
  email: string
  status: string
  hasPremium: boolean
  /**
   * Lists the subscription is actively on. Undefined when the response didn't
   * carry them (webhook payloads, writes) — unknown, not "none".
   */
  listIds?: string[]
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
  if (Array.isArray(d.newsletter_list_ids)) sub.listIds = d.newsletter_list_ids
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
  // Lists are expanded so every read also says which newsletters arrive.
  const url = `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}?expand[]=newsletter_lists`
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
  newsletter_list_ids?: string[]
  skip_newsletter_list_auto_subscribe?: boolean
}

async function createSubscription(
  publicationId: string,
  token: string,
  email: string,
  opts: {
    premiumTierId?: string
    // Exactly these lists, skipping the auto-subscribe ones — so joining one
    // newsletter never quietly signs the reader up for another.
    onlyLists?: string[]
  } = {},
): Promise<BeehiivSubscription> {
  const body: CreateBody = {
    email,
    // Re-subscribe readers who previously unsubscribed instead of erroring
    // (matches the public /api/beehiiv/subscribe behavior).
    reactivate_existing: true,
    utm_source: opts.premiumTierId ? 'ark-media-membership' : 'ark-media-website',
  }
  if (opts.premiumTierId) body.premium_tier_ids = [opts.premiumTierId]
  if (opts.onlyLists) {
    body.newsletter_list_ids = opts.onlyLists
    body.skip_newsletter_list_auto_subscribe = true
  }
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

type CustomFieldWrite = { name: string; value?: string; delete?: boolean }

type UpdateBody = {
  tier?: 'free' | 'premium'
  premium_tier_ids?: string[]
  unsubscribe?: boolean
  custom_fields?: CustomFieldWrite[]
  // Adds to the reader's lists / removes from them; neither replaces the set.
  // Beehiiv rejects either alongside `unsubscribe`.
  newsletter_list_ids?: string[]
  unsubscribe_newsletter_list_ids?: string[]
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

export type NewsletterState = {
  row: LocalSubscriptionRow | null
  /** The Current arrives. */
  current: boolean
  /** On the AMA list. Null when unknown: Beehiiv unreadable or no list configured. */
  ama: boolean | null
}

function projectState(env: Env, entry: RefreshCacheEntry): NewsletterState {
  const lists = newsletterListIds(env)
  const receiving = entry.row ? isReceivingEmails(entry.row.status) : false
  const onList = (id: string) =>
    entry.listIds ? receiving && entry.listIds.includes(id) : null
  return {
    row: entry.row,
    // Unreadable lists fall back to the mirror's publication status.
    current: lists.current ? (onList(lists.current) ?? receiving) : receiving,
    ama: lists.ama ? onList(lists.ama) : null,
  }
}

// The same refresh, projected to which newsletters the reader gets.
export async function refreshNewsletterState(
  deps: PushDeps,
  email: string,
): Promise<NewsletterState> {
  const cfg = beehiivConfigured(deps.env)
  const normalized = email.toLowerCase()
  if (!cfg) {
    const row = await getLocalSubscription(deps.sql, normalized)
    return projectState(deps.env, { row, listIds: null })
  }

  const cached = refreshCache.get(normalized)
  if (cached) return projectState(deps.env, cached)

  try {
    const sub = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)
    let entry: RefreshCacheEntry
    if (!sub) {
      await deleteLocalSubscription(deps.sql, normalized)
      entry = { row: null, listIds: [] }
    } else {
      await persistFromBeehiiv(deps.sql, cfg.pubId, sub)
      entry = {
        row: await getLocalSubscription(deps.sql, normalized),
        listIds: sub.listIds ?? null,
      }
    }
    refreshCache.set(normalized, entry)
    return projectState(deps.env, entry)
  } catch (err) {
    console.error(
      `[beehiiv-sync] refresh failed for ${redactEmail(email)}:`,
      err,
    )
    const row = await getLocalSubscription(deps.sql, normalized)
    return projectState(deps.env, { row, listIds: null })
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
  // The AMA list leaves with the tier, in the same PUT: Beehiiv can't gate a
  // list on the tier, so staying on it would keep mailing an unlisted link to
  // someone who is no longer a member. Also taken off a reader already without
  // the tier who is still on it (premium removed in Beehiiv's UI).
  const amaList = newsletterListIds(deps.env).ama
  const body: UpdateBody = {}
  if (existing.hasPremium) body.tier = 'free'
  if (amaList && existing.listIds?.includes(amaList)) {
    body.unsubscribe_newsletter_list_ids = [amaList]
  }
  const next =
    Object.keys(body).length > 0
      ? await updateSubscription(cfg.pubId, cfg.token, existing.id, body)
      : existing
  await persistFromBeehiiv(deps.sql, cfg.pubId, next)
  refreshCache.delete(normalized)
}

// Beehiiv keeps a record's lists through a publication-level unsubscribe and
// hands them back on reactivation, so a reader coming back for one newsletter
// would silently get the other too. After a reactivation, take the record off
// any of `others` it held before. (Verified against the live API 2026-10-01.)
async function dropRestoredLists(
  cfg: { pubId: string; token: string },
  before: BeehiivSubscription,
  others: Array<string | null>,
): Promise<void> {
  const restored = others.filter(
    (id): id is string => id !== null && (before.listIds ?? []).includes(id),
  )
  if (restored.length === 0) return
  await updateSubscription(cfg.pubId, cfg.token, before.id, {
    unsubscribe_newsletter_list_ids: restored,
  })
}

// Thrown when the AMA switch is used where no AMA list is configured
// (BEEHIIV_LIST_ID_AMA unset) — distinct from a Beehiiv failure so the route
// can say the feature is unavailable rather than "try again".
export class AmaListNotConfiguredError extends Error {
  constructor() {
    super('BEEHIIV_LIST_ID_AMA not set; cannot change the AMA list')
    this.name = 'AmaListNotConfiguredError'
  }
}

// Join or leave the AMA list. Independent of The Current: joining never adds
// the reader to it, leaving never removes them from it. The caller checks
// arkPlus before passing `on: true` — this helper does not.
export async function setAmaList(
  deps: PushDeps,
  email: string,
  on: boolean,
): Promise<void> {
  const cfg = beehiivConfigured(deps.env)
  const lists = newsletterListIds(deps.env)
  const amaList = lists.ama
  if (!cfg || !amaList) throw new AmaListNotConfiguredError()
  const normalized = email.toLowerCase()
  const existing = await getSubscriptionByEmail(cfg.pubId, cfg.token, normalized)

  if (!existing || (on && !isReceivingEmails(existing.status))) {
    // Nothing to leave without a record; otherwise there's no live record to
    // add a list to, so create (or reactivate) one on the AMA list alone. The
    // premium tier rides through a reactivation like applyPreferences does.
    if (!on) return
    const premiumTierId =
      existing?.hasPremium ? deps.env.BEEHIIV_PREMIUM_TIER_ID : undefined
    const created = await createSubscription(cfg.pubId, cfg.token, normalized, {
      premiumTierId,
      onlyLists: [amaList],
    })
    if (existing) await dropRestoredLists(cfg, existing, [lists.current])
    await persistFromBeehiiv(deps.sql, cfg.pubId, created)
  } else {
    await updateSubscription(
      cfg.pubId,
      cfg.token,
      existing.id,
      on
        ? { newsletter_list_ids: [amaList] }
        : { unsubscribe_newsletter_list_ids: [amaList] },
    )
    // Mirror the by_email read: a list-only PUT says nothing about the tier
    // (same reason as syncSubscriberName).
    await persistFromBeehiiv(deps.sql, cfg.pubId, existing)
  }
  // The next read goes to Beehiiv for the lists as they now stand.
  refreshCache.delete(normalized)
}

// Apply both toggles in one Beehiiv round-trip. `free` and `premium` are the
// desired final states; either may be omitted to leave that dimension alone.
// The caller is responsible for verifying entitlement before passing
// `premium: true` — this helper does not check.
//
// One shared publication = one record. `free` is The Current:
//   free=true  → on The Current's list, re-subscribing the record if needed.
//                If `premium` was not specified and the existing record had
//                premium, the tier is preserved (subject to Beehiiv's own
//                behavior on re-activation).
//   free=false → off The Current's list only. The record stays active, so the
//                AMA list, the tier and the private feed are untouched.
// With no BEEHIIV_LIST_ID_THE_CURRENT, `free` is the whole record instead:
// true re-activates it, false unsubscribes it (and so everything).
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
  const { current: currentList, ama: amaList } = newsletterListIds(deps.env)

  // Build a combined update body so we hit Beehiiv at most once for both
  // toggles. List/`unsubscribe`/tier fields are only set when the caller asked.
  const body: UpdateBody = {}
  if (prefs.free !== undefined && currentList) {
    if (prefs.free) body.newsletter_list_ids = [currentList]
    else body.unsubscribe_newsletter_list_ids = [currentList]
  } else if (prefs.free !== undefined) {
    body.unsubscribe = !prefs.free
  }
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
      // Back on The Current alone — not whatever else auto-subscribes.
      onlyLists: currentList ? [currentList] : undefined,
    })
    // An explicit premium downgrade requested alongside reactivation: apply it
    // in a follow-up PUT (create can't express tier=free).
    if (prefs.premium === false) {
      result = await updateSubscription(cfg.pubId, cfg.token, result.id, {
        tier: 'free',
      })
    }
    if (currentList) await dropRestoredLists(cfg, existing, [amaList])
  } else {
    result = await updateSubscription(cfg.pubId, cfg.token, existing.id, body)
  }
  await persistFromBeehiiv(deps.sql, cfg.pubId, result)
  // The write responses don't carry lists, so drop the cached read and let
  // the next one go to Beehiiv.
  refreshCache.delete(normalized)
  return getLocalSubscription(deps.sql, normalized)
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
