// ---------------------------------------------------------------------------
// Ark Insider — entitlement model + Circle sync + reconciliation
//
// Neon is the single entitlement authority (tasks/entitlement-tiers.md §2/§3):
// Auth0 answers "who are you," never "what can you access." This module owns:
//
//   1. The tier → entitlements model (GRANTS / deriveEntitlements).
//   2. The Circle axis: creating members, stamping the auth0_sub join field,
//      and moving them between the two community access groups
//      (CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID / CIRCLE_CANCELLED_ACCESS_GROUP_ID).
//      The arkPlus axis (Beehiiv's premium tier) is owned by lib/activation.ts
//      + the webhook.
//   3. The nightly reconciler — Neon-authoritative drift removal across both
//      external access systems (Beehiiv + Circle).
//
// Auth0 holds NO entitlement here. There is no tier claim and no app_metadata
// mirror to keep in sync (task 5) — a per-request Neon read on the sub is never
// stale and needs no second write that could disagree.
// ---------------------------------------------------------------------------

import type Stripe from 'stripe'
import { redactEmail } from '../shared/validation.js'
import { getManagementClient } from './auth0.js'
import {
  downgradeToFree as beehiivDowngradeToFree,
  loadPremiumSubscriberEmails,
  tryPush,
} from './lib/beehiiv-sync.js'
import { getDb } from './lib/db.js'
import {
  deleteExpiredGiftMemberships,
  loadAllMemberships as loadAllNeonMemberships,
} from './lib/membership.js'
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
// arkPlus → Beehiiv's premium tier (the private feed), circle → the Circle
// access group.
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

type CircleStatus = 'ok' | 'no-member' | 'skipped' | 'error'

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
// (Beehiiv) and the Neon membership row are owned by activation/webhook.
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

// Every Auth0 user id holding this email. Used by the reconciler to project a
// Beehiiv premium subscriber (keyed on email) onto a membership row (keyed on
// the Auth0 sub). Returns null — distinct from an empty array — when the lookup
// could not be performed, so callers can tell "no such user" from "we don't
// know" and refuse to revoke on the latter.
async function fetchAuth0SubsForEmail(
  env: Env,
  email: string,
): Promise<string[] | null> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return null
  try {
    const users = await mgmt.users.listUsersByEmail({
      email,
      fields: 'user_id',
      include_fields: true,
    })
    return users.map((u) => u.user_id).filter((id): id is string => Boolean(id))
  } catch {
    return null
  }
}

// --- Circle ----------------------------------------------------------------
// Circle's Admin v2 API. Members of the configured access group can see the
// Spaces gated to it; non-members can't. Two groups describe a member's standing
// in the Fold, both created once in Circle admin:
//
//   CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID — "subscriber". Holds the Fold's Spaces.
//   CIRCLE_CANCELLED_ACCESS_GROUP_ID  — "cancelled". Holds NO Spaces, so it
//     grants nothing; it is a marker, not an entitlement. Optional — unset, a
//     revoke is just the removal from "subscriber" it always was.
//
// The Admin v2 access-groups endpoints take email directly, so no separate
// member-id lookup is needed in the per-email path. Member-id resolution is
// still required for the reconciler's drift pass (see
// listCircleAccessGroupMembers) because the access-group list returns only ids.
//
// Every call below is Admin **v2** and authenticates with CIRCLE_ADMIN_API_TOKEN,
// with ONE deliberate exception: createCircleMemberV1, which is v1 + the v1
// token because `skip_invitation` exists nowhere else.
//
// They all used to send CIRCLE_API_TOKEN, which is an Admin **v1** token —
// perfectly valid, but only against /api/v1/*. As a Bearer on /api/admin/v2/*
// Circle answers 401 to all of it, so the entire Circle axis was failing
// silently: `provisionCircleMember` returned 'error' and the subscriber access
// group sat at zero members while people were paying for the Fold. The two
// tokens are distinct on purpose (they are two different APIs); a call site just
// has to hold the one for the version it is calling.

const CIRCLE_API = 'https://app.circle.so/api/admin/v2'
// Admin v1, used for exactly one call — see createCircleMemberV1.
const CIRCLE_API_V1 = 'https://app.circle.so/api/v1'

function accessGroupMembersUrl(groupId: string): string {
  return `${CIRCLE_API}/access_groups/${encodeURIComponent(groupId)}/community_members`
}

// Add an email to one access group. Answers whether the write landed on a real
// Circle member: `false` means 404 — the email has no community member record
// at all, which is a no-op rather than a failure.
//
// A duplicate add is not an error to Circle — re-adding a member already in the
// group answers 201, like the first add. 422 / 409 stay tolerated as well (the
// spec documents neither, and a tolerated duplicate is the right outcome however
// it is signalled). All other 4xx (400, 401, 403, ...) still throw so auth and
// validation errors surface.
async function addToAccessGroup(
  headers: Record<string, string>,
  groupId: string,
  email: string,
): Promise<boolean> {
  const res = await fetchWithTimeout(accessGroupMembersUrl(groupId), {
    method: 'POST',
    headers,
    body: JSON.stringify({ email }),
  })
  if (res.status === 404) return false
  if (!res.ok && res.status !== 422 && res.status !== 409) {
    throw new Error(`Circle access-group POST ${res.status}: ${await res.text()}`)
  }
  return true
}

// Remove an email from one access group. Answers whether it was actually IN the
// group: Circle 404s when it wasn't (never added, or no member record), which is
// already the desired state.
async function removeFromAccessGroup(
  headers: Record<string, string>,
  groupId: string,
  email: string,
): Promise<boolean> {
  const res = await fetchWithTimeout(
    `${accessGroupMembersUrl(groupId)}?email=${encodeURIComponent(email)}`,
    { method: 'DELETE', headers },
  )
  if (res.status === 404) return false
  if (!res.ok) {
    throw new Error(`Circle access-group DELETE ${res.status}: ${await res.text()}`)
  }
  return true
}

// Mirror the tier's circle entitlement onto the two groups — granted → in
// "subscriber", out of "cancelled"; revoked → the reverse.
//
// Revoking is a MOVE, never a delete. Nothing here (or anywhere else on the
// cancel path) touches the Circle community member or their Auth0 account: their
// posts, comments, DMs and profile survive a cancellation untouched, so someone
// who re-joins comes back to their own history rather than a blank account. The
// "cancelled" group is what makes that survivable to look at — it has no Spaces,
// so holding it grants nothing, and it lets the roster tell a lapsed member from
// someone who was never a subscriber (and gives win-back campaigns an audience).
//
// The access-critical write goes first in both directions and is the only one
// allowed to fail the call; the marker write is soft. Circle's groups are
// additive, so the marker can never gate anything either way.
async function setCircleAccessGroup(
  env: Env,
  email: string,
  wantCircle: boolean,
): Promise<'ok' | 'no-member' | 'skipped'> {
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 'skipped'
  const cancelledGroupId = env.CIRCLE_CANCELLED_ACCESS_GROUP_ID

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }

  if (wantCircle) {
    const added = await addToAccessGroup(headers, accessGroupId, email)
    // The email isn't a Circle community member yet. Treat as no-member,
    // matching the pre-access-group behavior; the user will be added on their
    // first Circle SSO. There is no member record to clear a marker off, either.
    if (!added) return 'no-member'
    if (cancelledGroupId) {
      try {
        await removeFromAccessGroup(headers, cancelledGroupId, email)
      } catch (err) {
        console.error(
          `[circle] cancelled-group clear failed for ${redactEmail(email)}:`,
          err,
        )
      }
    }
    return 'ok'
  }

  // wantCircle false → revoke.
  const wasSubscriber = await removeFromAccessGroup(headers, accessGroupId, email)
  // Only mark someone who was actually in the subscriber group. EVERY cancel
  // runs through here, Ark+-only members who never had the Fold included, and
  // tagging those "cancelled" would both misdescribe them and quietly poison any
  // win-back audience built off the group.
  if (wasSubscriber && cancelledGroupId) {
    try {
      await addToAccessGroup(headers, cancelledGroupId, email)
    } catch (err) {
      console.error(
        `[circle] cancelled-group tag failed for ${redactEmail(email)}:`,
        err,
      )
    }
  }
  return 'ok'
}

// The custom profile-field key on the Circle member that we stamp with the
// Auth0 `sub` at provisioning time. The reconciler (task 15) projects the
// access-group roster's community_member_id → auth0_sub through this field
// (sso_provider_user_id is still NULL pre-SSO), so the two must name the same
// field. Overridable via env for whatever the field is actually keyed as in the
// Circle admin. See tasks/entitlement-tiers.md §3 + §7 #9 (verify once wired).
function circleAuth0SubField(env: Env): string {
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
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 'skipped'
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }

  let memberId: number | null
  try {
    memberId = await ensureCircleMember(env, headers, email, name)
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

type CircleMemberCreateBody = {
  id?: number
  community_member_id?: number
  community_member?: { id?: number }
}

// Create (or find) the member. Prefers the v1 call, which is the only one that
// can suppress Circle's invitation email; falls back to v2 when v1 isn't
// configured — a member who gets one extra email is a far better outcome than a
// member who never gets Fold access at all.
async function ensureCircleMember(
  env: Env,
  v2Headers: Record<string, string>,
  email: string,
  name: string | undefined,
): Promise<number | null> {
  if (env.CIRCLE_API_TOKEN && env.CIRCLE_COMMUNITY_ID) {
    return createCircleMemberV1(env, email, name)
  }
  console.warn(
    '[circle] CIRCLE_API_TOKEN / CIRCLE_COMMUNITY_ID unset — creating via v2, which emails the member a community invitation',
  )
  return createCircleMemberV2(v2Headers, email, name)
}

// The ONE call in this file that is Admin **v1**, and deliberately so:
// `skip_invitation` exists only there. Without it Circle sends every new
// subscriber its own "you've been invited to the community" on top of our
// branded welcome email — a second, competing call to action for a product they
// just bought. Verified live against both APIs: v1 + skip_invitation delivers
// nothing, while v2 ignores every spelling of the idea (skip_invitation,
// send_invitation, skip_invitation_email, invitation) and always invites.
//
// Two v1 quirks this depends on, both verified:
//
//   1. Everything is HTTP 200 — failures included. `{ success: false }` is a bad
//      community id, `{ status: 'unauthorized' }` a bad token. Reading `res.ok`
//      here (the reflex from every other call in this file) would read both as a
//      successful create and hand back a null id.
//   2. A duplicate is `success: true` carrying the EXISTING member's id, so
//      create and find-existing are one call — no separate dedup branch.
async function createCircleMemberV1(
  env: Env,
  email: string,
  name: string | undefined,
): Promise<number | null> {
  const params = new URLSearchParams({
    community_id: env.CIRCLE_COMMUNITY_ID,
    email,
    skip_invitation: 'true',
  })
  if (name) params.set('name', name)
  const res = await fetchWithTimeout(`${CIRCLE_API_V1}/community_members?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${env.CIRCLE_API_TOKEN}` },
  })
  const body = (await res.json().catch(() => null)) as
    | (CircleMemberCreateBody & { success?: boolean; message?: string; status?: string })
    | null
  if (!res.ok || body?.success !== true) {
    throw new Error(
      `Circle v1 member create ${res.status}: ${body?.message ?? body?.status ?? 'unreadable body'}`,
    )
  }
  return body.community_member?.id ?? body.community_member_id ?? body.id ?? null
}

// The v2 create — the fallback, which always emails an invitation. A duplicate
// is not an error to Circle: an existing email comes back 201 with
// `{ message: "This user is already a member of this community.",
// community_member: { … } }`, the same envelope a fresh create returns, so both
// land on the same read. The id is NESTED under `community_member`; reading only
// a top-level `id` (as this did) returned null for every existing member and
// silently skipped the auth0_sub stamp.
async function createCircleMemberV2(
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
    const body = (await res.json().catch(() => null)) as CircleMemberCreateBody | null
    const id = body?.community_member?.id ?? body?.community_member_id ?? body?.id
    if (typeof id === 'number') return id
    // An envelope we don't recognise. Ask by email rather than give up on the
    // stamp — the search endpoint answers with the member object directly.
    return findCircleMemberIdByEmail(headers, email)
  }
  // 409 / 422 — what this endpoint was assumed to answer for duplicates before
  // the 201 was observed. Kept tolerated: a tolerated duplicate is never wrong.
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

// Push a member's name onto their Circle profile — the Fold's copy of the
// one thing every other store already hears about.
//
// PUT /api/account/profile fans an edited name out to Auth0 (its home) and
// Beehiiv. Circle was missing from that list, so a member who fixed their name
// with us still read as their old one in the Fold. Not a cosmetic gap: where we
// hold no name at all, Circle fills `first_name` with the whole email address,
// so that member appears to everyone else as "someone@example.com".
//
// Soft by construction — returns false rather than throwing. Every caller is
// downstream of a save the member has already seen succeed, so a Circle hiccup
// must never surface as a failed save.
// CIRCLE_ADMIN_API_TOKEN — which is now what every Circle call in this file
// uses. This function was for a while the only one that did, and the pairing it
// was tested with (admin token + v2 search + v2 PUT) is the one the rest of the
// file was corrected to:
//
//   Bearer <v1 token>    → /api/admin/v2/community_members/search  401
//   Bearer <admin token> → /api/admin/v2/community_members/search  200
//   Token  <v1 token>    → /api/v1/community_members               200
export async function updateCircleMemberName(
  env: Env,
  email: string,
  name: { first: string; last?: string | null },
): Promise<boolean> {
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
  if (!apiToken) return false
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }
  try {
    const memberId = await findCircleMemberIdByEmail(headers, email)
    // Not every member is in Circle — an Ark+-only member has no Fold
    // record, and that is not a failure worth logging as one.
    if (memberId == null) return false
    const res = await fetchWithTimeout(`${CIRCLE_API}/community_members/${memberId}`, {
      method: 'PUT',
      headers,
      // `last_name: null` clears a surname the member deleted, the same way the
      // Beehiiv sync treats it — an empty string would leave the old one merged
      // into their display name.
      body: JSON.stringify({
        first_name: name.first,
        last_name: name.last ?? null,
      }),
    })
    if (!res.ok) {
      console.error(
        `[circle] name PUT ${res.status} for ${redactEmail(email)}:`,
        await res.text(),
      )
      return false
    }
    return true
  } catch (err) {
    console.error(`[circle] name sync failed for ${redactEmail(email)}:`, err)
    return false
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
//   - arkPlus (Beehiiv premium tier): Beehiiv keys the grant — and therefore the
//     private feed — on EMAIL, so this axis cannot reconcile on an opaque id the
//     way the Circle one does. The roster is the premium newsletter mirror
//     (beehiiv_subscription where has_premium), and each email is projected onto
//     a membership row through Auth0 (email → sub → row). A premium grant whose
//     owner has no live arkPlus row is drift and is downgraded to free.
//     Projection failures NEVER revoke: an Auth0 lookup that errors, or an email
//     with no Auth0 user at all, is left alone — the same rule the Circle axis
//     applies to an unstamped member.
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
// Every removal pass is capped (ARK_PLUS_DRIFT_MAX_REMOVE /
// CIRCLE_DRIFT_MAX_REMOVE) so a bad roster response can't mass-revoke; overflow
// waits for the next run. Neon still holds no email: the arkPlus roster's
// addresses come from the Beehiiv mirror, and the Circle DELETE's from Circle.
//
// VERIFY-PENDING (§7 #9): the Circle member → auth0_sub custom-field projection
// (readCircleProfileField) is written against the assumed Admin v2 shape and
// must be confirmed against a live roster before this cron is enabled.

const ARK_PLUS_DRIFT_MAX_REMOVE = 100
const CIRCLE_DRIFT_MAX_REMOVE = 100

export type ReconcileSummary = {
  scanned: number // Neon rows loaded
  arkPlusRemoved: number
  circleRemoved: number
  errors: number
}

// The tier a set of live axes adds up to — the inverse of deriveEntitlements.
// Effective tier is DERIVED from which axes are live (gift stacking, D4), never
// stored: an Ark+ sub plus a live Fold gift is a bundle-equivalent member.
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
    return { scanned: 0, arkPlusRemoved: 0, circleRemoved: 0, errors: 0 }
  }

  const rows = await loadAllNeonMemberships(getDb(env))
  const live = rows.filter(membershipIsLive)

  // Per-axis keep-sets from Neon, keyed on the Auth0 sub — the only id a
  // membership row carries.
  const arkPlusSubs = new Set<string>()
  const circleSubs = new Set<string>()
  for (const r of live) {
    const ent = liveAxes(r)
    if (ent.arkPlus) arkPlusSubs.add(r.auth0_sub)
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

  const arkPlusRemoved = await reconcileArkPlusAxis(
    env,
    arkPlusSubs,
    batchSize,
  ).catch((err: unknown) => {
    console.error('[reconcile] arkPlus axis failed:', err)
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

  return { scanned: rows.length, arkPlusRemoved, circleRemoved, errors }
}

// arkPlus drift: strip the Beehiiv premium tier from anyone holding it whose
// Neon membership no longer grants arkPlus. Losing the tier is what revokes the
// private feed, so this is the safety net for a cancel whose webhook never
// landed.
//
// Unlike the Circle axis this cannot work on opaque ids: Beehiiv keys both the
// premium grant and the feed on email. So each premium email is projected onto
// a membership row through Auth0, and the projection is allowed to fail safely.
async function reconcileArkPlusAxis(
  env: Env,
  keep: Set<string>,
  batchSize: number,
): Promise<number> {
  if (!env.DATABASE_URL) return 0
  const sql = getDb(env)
  const roster = await loadPremiumSubscriberEmails(sql)

  // Fail-safe against a mass wipe. An empty keep-set against a non-empty roster
  // means Neon isn't a trustworthy authority this run (a truncated read, an
  // un-provisioned environment) and every premium member would classify as
  // drift. Skip rather than revoke live paid feeds — the per-run cap alone
  // wouldn't save a roster from being drained over successive nightly runs.
  if (roster.length === 0) return 0
  if (keep.size === 0) {
    console.error(
      '[reconcile] arkPlus keep-set empty but premium roster non-empty — skipping removal',
    )
    return 0
  }

  // Resolve first, remove second, so the cap applies to confirmed drift only.
  const drift: string[] = []
  let unresolved = 0
  await batched(roster, batchSize, async (email) => {
    const subs = await fetchAuth0SubsForEmail(env, email)
    // null = the lookup itself failed; [] = no Auth0 user for this address.
    // Neither is evidence the member lost their entitlement, and revoking on a
    // failed projection is exactly how a safety net turns into an outage.
    if (subs === null || subs.length === 0) {
      unresolved += 1
      return
    }
    if (subs.some((sub) => keep.has(sub))) return
    drift.push(email)
  })
  if (unresolved > 0) {
    console.warn(
      `[reconcile] arkPlus: ${unresolved} premium subscriber(s) could not be projected onto a membership row — left alone`,
    )
  }

  const capped = drift.slice(0, ARK_PLUS_DRIFT_MAX_REMOVE)
  if (drift.length > capped.length) {
    console.warn(
      `[reconcile] arkPlus drift exceeded cap ${ARK_PLUS_DRIFT_MAX_REMOVE}; overflow waits for next run`,
    )
  }
  await batched(capped, batchSize, async (email) => {
    await tryPush('reconcile arkPlus drift', () =>
      beehiivDowngradeToFree({ env, sql }, email),
    )
  })
  return capped.length
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
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 0

  const members = await listCircleAccessGroupMembers(env, maxPages)
  // Same fail-safe as the arkPlus axis: an empty keep-set against a populated access
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
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
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
