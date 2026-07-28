// ---------------------------------------------------------------------------
// Ark Insider — entitlement model + Circle sync + reconciliation
//
// Neon is the single entitlement authority (tasks/entitlement-tiers.md §2/§3):
// Auth0 answers "who are you," never "what can you access." This module owns:
//
//   1. The tier → entitlements model (GRANTS / deriveEntitlements).
//   2. The Circle axis: creating members, stamping the auth0_sub join field,
//      and adding/removing the community access group
//      (CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID). The arkPlus axis (Supporting Cast)
//      is owned by lib/activation.ts + the webhook.
//   3. The nightly reconciler — Neon-authoritative drift removal across both
//      external access systems (SC + Circle), keyed on opaque ids, never email.
//
// Auth0 holds NO entitlement here. There is no tier claim and no app_metadata
// mirror to keep in sync (task 5) — a per-request Neon read on the sub is never
// stale and needs no second write that could disagree.
// ---------------------------------------------------------------------------

import type Stripe from 'stripe'
import { redactEmail } from '../shared/validation.js'
import { getManagementClient } from './auth0.js'
import { downgradeToFree as beehiivDowngradeToFree, tryPush } from './lib/beehiiv-sync.js'
import { getDb } from './lib/db.js'
import {
  deleteExpiredGiftMemberships,
  loadAllMemberships as loadAllNeonMemberships,
} from './lib/membership.js'
import {
  createScClient,
  createScV1Client,
  loadAllMemberships as loadAllScMemberships,
} from './lib/sc-client.js'
import { fetchWithTimeout } from "./lib/http.js"

type Env = Record<string, string>

// The SKU sold (billing/copy). Entitlements are what it GRANTS — kept apart so
// every gate checks an entitlement, never a tier. See tasks/entitlement-tiers.md
// §2.
export type Tier = 'ark-plus' | 'circle' | 'bundle' | 'free'

export type Entitlements = { arkPlus: boolean; circle: boolean }

const GRANTS: Record<Tier, Entitlements> = {
  'ark-plus': { arkPlus: true, circle: false },
  circle: { arkPlus: false, circle: true },
  bundle: { arkPlus: true, circle: true },
  free: { arkPlus: false, circle: false },
}

// The one place tier → entitlements. Entitlements are always derived, never
// stored (no drift). The two axes map 1:1 onto the two external access systems:
// arkPlus → Supporting Cast (the private feed), circle → the Circle access group.
export function deriveEntitlements(tier: Tier): Entitlements {
  // The row's `tier` is a free-text column, so a corrupt value typed as Tier can
  // reach here at runtime; fall back to no entitlements (and log) rather than
  // returning undefined and throwing `.arkPlus of undefined` through a gate.
  const grant = GRANTS[tier]
  if (!grant) {
    console.error(`[entitlement] unknown tier "${tier}" — treating as free`)
    return GRANTS.free
  }
  return grant
}

// Map a catalog product's `entitlements` metadata (comma-separated `ark_plus` /
// `circle`) to the Tier it sells. The webhook derives tier this way — from the
// price product, the authority — rather than trusting client-stamped metadata.
// Unrecognised / empty → 'free'.
export function tierFromEntitlementString(raw: string | null | undefined): Tier {
  const set = new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const arkPlus = set.has('ark_plus')
  const circle = set.has('circle')
  if (arkPlus && circle) return 'bundle'
  if (arkPlus) return 'ark-plus'
  if (circle) return 'circle'
  return 'free'
}

export type CircleStatus = 'ok' | 'no-member' | 'skipped' | 'error'

// The result of syncing the Circle axis for one member. Auth0 is no longer a
// sync target (§2), so this carries only the circle status.
export type EntitlementResult = {
  email: string
  tier: Tier
  entitlements: Entitlements
  circle: CircleStatus
}

// Mirror the Circle access group to the tier's circle entitlement. This is the
// one external write syncEntitlement still performs — the arkPlus axis
// (Supporting Cast) and the Neon membership row are owned by activation/webhook.
// A tier that grants circle → add to the group (idempotent); one that doesn't →
// remove. Soft: a Circle outage yields 'error', never throws through the caller.
export async function syncEntitlement(
  env: Env,
  email: string,
  tier: Tier,
): Promise<EntitlementResult> {
  const entitlements = deriveEntitlements(tier)
  let circle: CircleStatus
  try {
    circle = await setCircleAccessGroup(env, email, entitlements.circle)
  } catch (reason) {
    console.error(`[entitlement] circle sync failed for ${redactEmail(email)}:`, reason)
    circle = 'error'
  }
  return { email, tier, entitlements, circle }
}

// --- Auth0 (authentication only) -------------------------------------------

// Used by the Circle SSO route to gate access on email verification. Returns
// true only if Auth0 has at least one identity for this email with
// email_verified=true. Returns null on any lookup failure so callers can
// decide whether to fail open or closed.
export async function fetchAuth0EmailVerified(
  env: Env,
  email: string,
): Promise<boolean | null> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return null
  let users: Array<{ email_verified?: boolean }>
  try {
    users = await mgmt.users.listUsersByEmail({
      email,
      fields: 'email_verified',
      include_fields: true,
    })
  } catch {
    return null
  }
  if (users.length === 0) return null
  return users.some((u) => u.email_verified === true)
}

// --- Circle ----------------------------------------------------------------
// Circle's Admin v2 API. Members of the configured access group can see the
// Spaces gated to it; non-members can't. The group's ID is created once in
// Circle admin and stored as CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID.
//
// The Admin v2 access-groups endpoints take email directly, so no separate
// member-id lookup is needed in the per-email path. Member-id resolution is
// still required for the reconciler's drift pass (see
// listCircleAccessGroupSubscriberEmails) because the access-group list
// returns only ids.

const CIRCLE_API = 'https://app.circle.so/api/admin/v2'

async function setCircleAccessGroup(
  env: Env,
  email: string,
  wantCircle: boolean,
): Promise<'ok' | 'no-member' | 'skipped'> {
  const apiToken = env.CIRCLE_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 'skipped'

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }
  const base = `${CIRCLE_API}/access_groups/${encodeURIComponent(accessGroupId)}/community_members`

  if (wantCircle) {
    const res = await fetchWithTimeout(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email }),
    })
    // 404 → the email isn't a Circle community member yet. Treat as
    // no-member, matching the pre-access-group behavior; the user will be
    // added on their first Circle SSO.
    if (res.status === 404) return 'no-member'
    // 422 / 409 → already a member (Circle's response code for duplicates is
    // undocumented in the Admin v2 spec; both have been observed in practice).
    // Treat as in-desired-state. All other 4xx (400, 401, 403, ...) still
    // throw so auth and validation errors surface.
    if (!res.ok && res.status !== 422 && res.status !== 409) {
      throw new Error(`Circle access-group POST ${res.status}: ${await res.text()}`)
    }
    return 'ok'
  }

  // wantCircle false → remove
  const res = await fetchWithTimeout(
    `${base}?email=${encodeURIComponent(email)}`,
    { method: 'DELETE', headers },
  )
  // 404 → not in the group already (either never was, or no member record).
  // Treat as desired state.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Circle access-group DELETE ${res.status}: ${await res.text()}`)
  }
  return 'ok'
}

// The custom profile-field key on the Circle member that we stamp with the
// Auth0 `sub` at provisioning time. The reconciler (task 15) projects the
// access-group roster's community_member_id → auth0_sub through this field
// (sso_provider_user_id is still NULL pre-SSO), so the two must name the same
// field. Overridable via env for whatever the field is actually keyed as in the
// Circle admin. See tasks/entitlement-tiers.md §3 + §7 #9 (verify once wired).
export function circleAuth0SubField(env: Env): string {
  return env.CIRCLE_AUTH0_SUB_FIELD_KEY || 'auth0_sub'
}

export type CircleProvisionStatus = 'ok' | 'skipped' | 'error'

// Create (or find) the Circle community member for this buyer at pay time —
// BEFORE their first Circle SSO — so adding them to the access group can't 404
// (§3, task 4) and app login works immediately. Then stamp the Auth0 `sub` into
// the reconciler's join field and add them to the subscriber access group.
//
// Idempotent and soft per step: a duplicate create, an already-in-group add, or
// a field-stamp hiccup must not fail provisioning of the paid product. Returns
// 'skipped' when Circle isn't configured, 'error' when the member couldn't be
// ensured (so the caller can flag it), 'ok' otherwise.
//
// The exact Circle Admin v2 create + custom-field shapes are pending empirical
// verification (§7 #9) — both writes are wrapped so an unexpected shape logs and
// degrades rather than throwing through provisioning.
export async function provisionCircleMember(
  env: Env,
  email: string,
  name: string | undefined,
  auth0Sub: string | null,
): Promise<CircleProvisionStatus> {
  const apiToken = env.CIRCLE_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 'skipped'
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }

  let memberId: number | null
  try {
    memberId = await ensureCircleMember(headers, email, name)
  } catch (err) {
    console.error(`[circle] ensure member failed for ${redactEmail(email)}:`, err)
    return 'error'
  }

  if (auth0Sub && memberId != null) {
    try {
      await stampCircleAuth0Sub(headers, memberId, circleAuth0SubField(env), auth0Sub)
    } catch (err) {
      console.error('[circle] auth0_sub field stamp failed:', err)
    }
  }

  try {
    await setCircleAccessGroup(env, email, true)
  } catch (err) {
    console.error(`[circle] access-group add failed for ${redactEmail(email)}:`, err)
    return 'error'
  }
  return 'ok'
}

// POST /community_members to create the member; a duplicate (Circle answers 409
// or 422 for an existing email) is treated as success. Returns the member id
// when Circle hands one back — on create or by a follow-up email lookup — so the
// caller can stamp the custom field; null when it can't be resolved (the add-to-
// group step still works off email, and the reconciler can re-stamp later).
async function ensureCircleMember(
  headers: Record<string, string>,
  email: string,
  name: string | undefined,
): Promise<number | null> {
  const res = await fetchWithTimeout(`${CIRCLE_API}/community_members`, {
    method: 'POST',
    headers,
    body: JSON.stringify(name ? { email, name } : { email }),
  })
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { id?: number; community_member_id?: number }
      | null
    return body?.community_member_id ?? body?.id ?? null
  }
  // 409 / 422 → already a member. Resolve the id by email so we can still stamp.
  if (res.status === 409 || res.status === 422) {
    return findCircleMemberIdByEmail(headers, email)
  }
  throw new Error(`Circle member create ${res.status}: ${await res.text()}`)
}

async function findCircleMemberIdByEmail(
  headers: Record<string, string>,
  email: string,
): Promise<number | null> {
  const res = await fetchWithTimeout(
    `${CIRCLE_API}/community_members/search?email=${encodeURIComponent(email)}`,
    { headers },
  )
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as
    | { records?: Array<{ id?: number }>; id?: number }
    | null
  return body?.records?.[0]?.id ?? body?.id ?? null
}

// Write the Auth0 `sub` onto the member's custom profile field. Isolated so the
// (unverified) endpoint shape lives in one place. Throws on a non-2xx so the
// caller's try/catch can log-and-continue.
async function stampCircleAuth0Sub(
  headers: Record<string, string>,
  memberId: number,
  fieldKey: string,
  auth0Sub: string,
): Promise<void> {
  const res = await fetchWithTimeout(`${CIRCLE_API}/community_members/${memberId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ profile_fields: { [fieldKey]: auth0Sub } }),
  })
  if (!res.ok) {
    throw new Error(`Circle profile-field PUT ${res.status}: ${await res.text()}`)
  }
}

// --- Stripe customer → email ------------------------------------------------

export async function emailForStripeCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  stripe: Stripe,
): Promise<string | null> {
  if (!customer) return null
  if (typeof customer === 'object') {
    if ('deleted' in customer && customer.deleted) return null
    return customer.email ?? null
  }
  const c = await stripe.customers.retrieve(customer)
  if (c.deleted) return null
  return c.email ?? null
}

// --- Reconciliation (Neon-authoritative drift removal) ----------------------
//
// Neon is the entitlement authority (§3). This nightly pass heals DRIFT between
// Neon and the two external access systems — a member who lost an axis in Neon
// (cancel, downgrade, expired gift) but whose external grant a webhook failed to
// revoke. It reconciles on OPAQUE IDS, never email:
//
//   - arkPlus (Supporting Cast): the keep-set is the sc_user_id of every live
//     arkPlus Neon row. Any SC member whose user_id isn't in it is drift — the
//     SC user is deleted (SC only holds paid-feed members, so a non-arkPlus SC
//     user is by definition stale).
//   - circle (Circle access group): the keep-set is the auth0_sub of every live
//     circle Neon row. The access-group roster returns community_member_id; we
//     project each to its stamped `auth0_sub` custom profile field and remove
//     anyone whose auth0_sub isn't in the keep-set.
//
// Grants are NOT healed here — they flow through the idempotent webhook +
// activation path, and re-granting would need the price / currency / email the
// Neon row deliberately doesn't hold. The reconciler is a removal safety net;
// run the backfill first so live members already have rows (§9).
//
// Every removal pass is capped (SC_DRIFT_MAX_REMOVE / CIRCLE_DRIFT_MAX_REMOVE)
// so a bad roster response can't mass-revoke; overflow waits for the next run.
// Email appears only as a transient write-address (Beehiiv downgrade, Circle
// DELETE), sourced from the roster — never from Neon.
//
// VERIFY-PENDING (§7 #9): the Circle member → auth0_sub custom-field projection
// (readCircleProfileField) is written against the assumed Admin v2 shape and
// must be confirmed against a live roster before this cron is enabled.

const SC_DRIFT_MAX_REMOVE = 100
const CIRCLE_DRIFT_MAX_REMOVE = 100

export type ReconcileSummary = {
  scanned: number // Neon rows loaded
  scRemoved: number
  circleRemoved: number
  errors: number
}

// The tier a set of live axes adds up to — the inverse of deriveEntitlements.
// Effective tier is DERIVED from which axes are live (gift stacking, D4), never
// stored: an Ark+ sub plus a live Community gift is a bundle-equivalent member.
export function tierFromEntitlements(ent: Entitlements): Tier {
  if (ent.arkPlus && ent.circle) return 'bundle'
  if (ent.arkPlus) return 'ark-plus'
  if (ent.circle) return 'circle'
  return 'free'
}

// The entitlement axes a membership row grants RIGHT NOW — the union of:
//   - base axes: a row with a live subscription grants its tier's axes (dunning
//     rows still grant; a full cancel deletes the row). A row with NO
//     subscription and NO gift term is a comp / staff / legacy grant — perpetual
//     access to its tier (matching the pre-per-axis "non-free tier = live").
//   - gift axes: each per-axis gift expiry still in the future grants that axis.
// A gift-only row has no subscription and at least one gift expiry, so its axes
// come purely from the two gift expiries. This is the single predicate behind the
// resolver's per-request gate and the reconciler's keep-set. Absence of a row =
// free (no axes).
export function liveAxes(row: {
  tier: Tier
  stripe_subscription_id: string | null
  ark_plus_gift_expires_at: string | null
  circle_gift_expires_at: string | null
}): Entitlements {
  const now = Date.now()
  const hasGift =
    row.ark_plus_gift_expires_at != null || row.circle_gift_expires_at != null
  // Subscription row → its tier; comp/staff row (no sub, no gift) → perpetual its
  // tier; gift-only row → no base axes (gift expiries decide below).
  const base =
    row.stripe_subscription_id != null || !hasGift ? deriveEntitlements(row.tier) : GRANTS.free
  const giftArkPlus =
    row.ark_plus_gift_expires_at != null && Date.parse(row.ark_plus_gift_expires_at) > now
  const giftCircle =
    row.circle_gift_expires_at != null && Date.parse(row.circle_gift_expires_at) > now
  return {
    arkPlus: base.arkPlus || giftArkPlus,
    circle: base.circle || giftCircle,
  }
}

// A membership row is live when it still grants at least one axis. Behind both
// the resolver's per-request gate and the reconciler's keep-set.
export function membershipIsLive(row: {
  tier: Tier
  stripe_subscription_id: string | null
  ark_plus_gift_expires_at: string | null
  circle_gift_expires_at: string | null
}): boolean {
  const axes = liveAxes(row)
  return axes.arkPlus || axes.circle
}

export async function reconcileEntitlements(
  env: Env,
  _stripe: Stripe,
  opts: { maxPages?: number; batchSize?: number } = {},
): Promise<ReconcileSummary> {
  const maxPages = opts.maxPages ?? 10
  const batchSize = opts.batchSize ?? 8
  let errors = 0

  if (!env.DATABASE_URL) {
    // Neon is the authority; without it there's nothing to reconcile against.
    console.warn('[reconcile] no DATABASE_URL — skipping (Neon is the authority)')
    return { scanned: 0, scRemoved: 0, circleRemoved: 0, errors: 0 }
  }

  const rows = await loadAllNeonMemberships(getDb(env))
  const live = rows.filter(membershipIsLive)

  // Per-axis keep-sets from Neon, keyed on opaque ids.
  const arkPlusScUserIds = new Set<number>()
  const circleSubs = new Set<string>()
  // A live arkPlus row whose sc_user_id is null can't be matched to an SC roster
  // entry, so it can't be added to the keep-set — but that member may still have
  // a live SC feed, which the axis would then delete as drift. If ANY such row
  // exists the keep-set is known-incomplete, so we skip SC removal that run
  // rather than risk revoking a paid feed we simply couldn't key.
  let arkPlusMissingScId = false
  for (const r of live) {
    const ent = liveAxes(r)
    if (ent.arkPlus) {
      if (r.sc_user_id != null) arkPlusScUserIds.add(r.sc_user_id)
      else arkPlusMissingScId = true
    }
    if (ent.circle) circleSubs.add(r.auth0_sub)
  }

  // Housekeeping: drop provably-expired gift membership rows (customer-less rows
  // whose gift term has elapsed). Reads already ignore them, but leaving them
  // makes any status-based logic (e.g. the gift-redeem stacking check) wrong.
  try {
    await deleteExpiredGiftMemberships(getDb(env))
  } catch (err) {
    console.error('[reconcile] expired-gift cleanup failed:', err)
    errors += 1
  }

  const scRemoved = await reconcileScAxis(
    env,
    arkPlusScUserIds,
    arkPlusMissingScId,
    batchSize,
  ).catch((err: unknown) => {
    console.error('[reconcile] SC axis failed:', err)
    errors += 1
    return 0
  })
  const circleRemoved = await reconcileCircleAxis(
    env,
    circleSubs,
    maxPages,
    batchSize,
  ).catch((err: unknown) => {
    console.error('[reconcile] Circle axis failed:', err)
    errors += 1
    return 0
  })

  return { scanned: rows.length, scRemoved, circleRemoved, errors }
}

// arkPlus drift: delete SC users whose user_id isn't in Neon's live arkPlus
// keep-set (SC only holds paid-feed members, so a non-arkPlus SC user is stale).
// Capped; also drops the removed member's Beehiiv premium (email from the SC
// roster is a transient write-address).
async function reconcileScAxis(
  env: Env,
  keep: Set<number>,
  keepIncomplete: boolean,
  batchSize: number,
): Promise<number> {
  if (!env.SC_API_KEY) return 0 // SC not configured
  // The membership roster lives on the SC v1 API (key-scoped, no network id in
  // the path); DELETE /users is v2. Using the v2 client for the roster load
  // 404s, throws, and silently disables all SC drift removal — so the two calls
  // need their two distinct clients.
  const scV1 = createScV1Client(env)
  const scV2 = createScClient(env)
  const roster = await loadAllScMemberships(scV1)

  // Fail-safe against a mass wipe. An empty keep-set against a non-empty roster
  // (Neon not yet backfilled, a truncated roster read) would classify every SC
  // member as drift; a known-incomplete keep-set (an arkPlus row with no
  // sc_user_id) could delete a member we just couldn't key. In either case skip
  // removal this run rather than revoke live paid feeds — the cap alone wouldn't
  // save a roster from being wiped over successive nightly runs.
  if (roster.length === 0) return 0
  if (keep.size === 0) {
    console.error(
      '[reconcile] SC keep-set empty but roster non-empty — skipping removal (run the backfill?)',
    )
    return 0
  }
  if (keepIncomplete) {
    console.warn(
      '[reconcile] SC keep-set incomplete (arkPlus row with null sc_user_id) — skipping removal this run',
    )
    return 0
  }

  const drift = roster
    .filter((m) => !keep.has(m.user_id))
    .slice(0, SC_DRIFT_MAX_REMOVE)
  if (roster.filter((m) => !keep.has(m.user_id)).length > SC_DRIFT_MAX_REMOVE) {
    console.warn(
      `[reconcile] SC drift exceeded cap ${SC_DRIFT_MAX_REMOVE}; overflow waits for next run`,
    )
  }
  await batched(drift, batchSize, async (m) => {
    try {
      await scV2.call('DELETE', `/users/${m.user_id}`)
    } catch (err) {
      console.error(`[reconcile] SC delete user ${m.user_id} failed:`, err)
      return
    }
    if (m.email && env.DATABASE_URL) {
      await tryPush('reconcile SC drift', () =>
        beehiivDowngradeToFree({ env, sql: getDb(env) }, m.email),
      )
    }
  })
  return drift.length
}

// circle drift: remove access-group members whose stamped auth0_sub isn't in
// Neon's live circle keep-set. Only removes members we can positively identify
// as stale — a member whose auth0_sub field is empty (SSO-created, never
// stamped) is left alone, since removing on a failed projection would revoke a
// legit member. Capped per group.
async function reconcileCircleAxis(
  env: Env,
  keep: Set<string>,
  maxPages: number,
  batchSize: number,
): Promise<number> {
  const apiToken = env.CIRCLE_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 0

  const members = await listCircleAccessGroupMembers(env, maxPages)
  // Same fail-safe as the SC axis: an empty keep-set against a populated access
  // group means Neon isn't the trustworthy authority yet (unbackfilled / bad
  // read), so skip removal rather than clear the whole community group.
  if (members.length > 0 && keep.size === 0) {
    console.error(
      '[reconcile] Circle keep-set empty but access group non-empty — skipping removal (run the backfill?)',
    )
    return 0
  }
  const stale = members.filter(
    (m) => m.auth0Sub != null && !keep.has(m.auth0Sub) && m.email != null,
  )
  const drift = stale.slice(0, CIRCLE_DRIFT_MAX_REMOVE)
  if (stale.length > CIRCLE_DRIFT_MAX_REMOVE) {
    console.warn(
      `[reconcile] Circle drift exceeded cap ${CIRCLE_DRIFT_MAX_REMOVE}; overflow waits for next run`,
    )
  }
  await batched(drift, batchSize, async (m) => {
    try {
      // email is non-null here (filtered above); the write-address is transient.
      await setCircleAccessGroup(env, m.email as string, false)
    } catch (err) {
      console.error('[reconcile] Circle remove failed:', err)
    }
  })
  return drift.length
}

type CircleReconcileMember = {
  communityMemberId: number
  auth0Sub: string | null
  email: string | null
}

// Project the subscriber access group's roster to { community_member_id,
// auth0_sub, email }. The access-group list returns only community_member_id, so
// we page it, then walk the full member roster to resolve each id to its email +
// stamped auth0_sub custom field. Both walks share the same maxPages budget.
async function listCircleAccessGroupMembers(
  env: Env,
  maxPages: number,
): Promise<CircleReconcileMember[]> {
  const apiToken = env.CIRCLE_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return []
  const headers = { Authorization: `Bearer ${apiToken}` }
  const fieldKey = circleAuth0SubField(env)

  // 1. community_member_ids in the access group.
  const memberIds = new Set<number>()
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      `${CIRCLE_API}/access_groups/${encodeURIComponent(accessGroupId)}/community_members` +
      `?per_page=100&page=${page}`
    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) {
      throw new Error(`Circle access-group list ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as {
      records?: Array<{ community_member_id?: number }>
      has_next_page?: boolean
    }
    const records = body.records ?? []
    for (const r of records) {
      if (typeof r.community_member_id === 'number') memberIds.add(r.community_member_id)
    }
    if (records.length < 100 || body.has_next_page === false) break
  }
  if (memberIds.size === 0) return []

  // 2. Resolve ids → { email, auth0_sub } by walking the member roster.
  const out: CircleReconcileMember[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${CIRCLE_API}/community_members?per_page=100&page=${page}`
    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) {
      throw new Error(`Circle members list ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as {
      records?: CircleMemberRecord[]
      has_next_page?: boolean
    }
    const records = body.records ?? []
    for (const r of records) {
      if (typeof r.id === 'number' && memberIds.has(r.id)) {
        out.push({
          communityMemberId: r.id,
          email: typeof r.email === 'string' ? r.email.toLowerCase() : null,
          auth0Sub: readCircleProfileField(r, fieldKey),
        })
      }
    }
    if (out.length >= memberIds.size) break
    if (records.length < 100 || body.has_next_page === false) break
  }
  return out
}

type CircleMemberRecord = {
  id?: number
  email?: string
  profile_fields?: Record<string, unknown>
  custom_fields?: Record<string, unknown>
  fields?: Array<{ key?: string; value?: unknown }>
}

// The stamped auth0_sub, read tolerantly across a few plausible Circle Admin v2
// shapes (the exact one is §7 #9 verify-pending): a profile_fields / custom_fields
// map, or a fields[] array of { key, value }. Null when unstamped.
function readCircleProfileField(r: CircleMemberRecord, fieldKey: string): string | null {
  const fromMap = r.profile_fields?.[fieldKey] ?? r.custom_fields?.[fieldKey]
  if (typeof fromMap === 'string' && fromMap) return fromMap
  const fromArr = r.fields?.find((f) => f.key === fieldKey)?.value
  if (typeof fromArr === 'string' && fromArr) return fromArr
  return null
}

async function batched<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    const res = await Promise.all(chunk.map(fn))
    out.push(...res)
  }
  return out
}
