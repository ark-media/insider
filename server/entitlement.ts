// ---------------------------------------------------------------------------
// Ark Insider — entitlement model + Circle sync + reconciliation
//
// Neon is the single entitlement authority (tasks/entitlement-tiers.md §2/§3):
// Auth0 answers "who are you," never "what can you access." This module owns:
//
//   1. The tier → entitlements model (GRANTS / deriveEntitlements).
//   2. The Circle axis: creating members and moving them between the two community access groups
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
// Beehiiv premium subscriber or a Circle group member (both keyed on email) onto
// a membership row (keyed on the Auth0 sub). Returns null — distinct from an empty array — when the lookup
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
// token because `skip_invitation` exists nowhere else. The two tokens are
// distinct on purpose (they are two different APIs); a call site has to hold
// the one for the version it is calling.

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

export type CircleProvisionStatus = 'ok' | 'skipped' | 'error'

// Create (or find) the Circle community member for this buyer at pay time —
// BEFORE their first Circle SSO — so adding them to the access group can't 404
// (§3, task 4) and app login works immediately. Then add them to the subscriber
// access group.
//
// Idempotent: a duplicate create or an already-in-group add is success. Returns
// 'skipped' when Circle isn't configured, 'error' when the member couldn't be
// ensured or put in the group (so the caller can retry), 'ok' otherwise. Never
// throws.
export async function provisionCircleMember(
  env: Env,
  email: string,
  name: string | undefined,
): Promise<CircleProvisionStatus> {
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 'skipped'
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }

  try {
    await ensureCircleMember(env, headers, email, name)
  } catch (err) {
    console.error(`[circle] ensure member failed for ${redactEmail(email)}:`, err)
    return 'error'
  }

  try {
    const added = await setCircleAccessGroup(env, email, true)
    // 'no-member' right after ensureCircleMember succeeded means the member we
    // just created (or found) isn't one the access-group endpoint can see. That
    // is not "in the group", and reporting 'ok' would stamp the provisioned
    // marker on a member who can't open a single Fold space.
    if (added === 'no-member') {
      console.error(
        `[circle] access-group add found no member for ${redactEmail(email)} after create`,
      )
      return 'error'
    }
  } catch (err) {
    console.error(`[circle] access-group add failed for ${redactEmail(email)}:`, err)
    return 'error'
  }
  return 'ok'
}

// Create (or find) the member. Prefers the v1 call, which is the only one that
// can suppress Circle's invitation email; falls back to v2 when v1 isn't
// configured — a member who gets one extra email is a far better outcome than a
// member who never gets Fold access at all. Throws when the member can't be
// ensured; the access-group add that follows is keyed on email, so no id is
// needed back.
async function ensureCircleMember(
  env: Env,
  v2Headers: Record<string, string>,
  email: string,
  name: string | undefined,
): Promise<void> {
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
//      successful create.
//   2. A duplicate is `success: true` for the EXISTING member, so create and
//      find-existing are one call — no separate dedup branch.
async function createCircleMemberV1(
  env: Env,
  email: string,
  name: string | undefined,
): Promise<void> {
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
    | { success?: boolean; message?: string; status?: string }
    | null
  if (!res.ok || body?.success !== true) {
    throw new Error(
      `Circle v1 member create ${res.status}: ${body?.message ?? body?.status ?? 'unreadable body'}`,
    )
  }
}

// The v2 create — the fallback, which always emails an invitation. A duplicate
// is not an error to Circle: an existing email comes back 201 with
// `{ message: "This user is already a member of this community." }`, the same
// as a fresh create. 409 / 422 — what this endpoint was assumed to answer for
// duplicates before the 201 was observed — stay tolerated: a tolerated
// duplicate is never wrong.
async function createCircleMemberV2(
  headers: Record<string, string>,
  email: string,
  name: string | undefined,
): Promise<void> {
  const res = await fetchWithTimeout(`${CIRCLE_API}/community_members`, {
    method: 'POST',
    headers,
    body: JSON.stringify(name ? { email, name } : { email }),
  })
  if (res.ok || res.status === 409 || res.status === 422) return
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

// Push a member's name onto their Circle profile — the Fold's copy of the
// one thing every other store already hears about.
//
// PUT /api/account/profile fans an edited name out to Auth0 (its home),
// Beehiiv, and Circle. Soft by construction — returns false rather than
// throwing. Every caller is downstream of a save the member has already seen
// succeed, so a Circle hiccup must never surface as a failed save.
//
// CIRCLE_ADMIN_API_TOKEN, same as every other Circle call in this file:
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
// revoke. Both external systems key their grant on EMAIL, and Neon holds none,
// so each roster email is projected onto membership rows through Auth0
// (email → subs → row) and compared against the per-axis keep-set of live subs:
//
//   - arkPlus (Beehiiv premium tier, and therefore the private feed): the roster
//     is the premium newsletter mirror (beehiiv_subscription where has_premium).
//     A premium grant whose owner has no live arkPlus row is downgraded to free.
//   - circle (the subscriber access group): the roster is the group's members.
//     One whose owner has no live circle row is moved to the cancelled group.
//
// Projection failures NEVER revoke: an Auth0 lookup that errors, or an email
// with no Auth0 user at all, is left alone.
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
// The Circle pass is a dry run — find and log, remove nothing — unless
// CIRCLE_RECONCILE_ENFORCE is 'true', so the first real roster can be checked
// before anyone loses access.

const ARK_PLUS_DRIFT_MAX_REMOVE = 100
const CIRCLE_DRIFT_MAX_REMOVE = 100

export type ReconcileSummary = {
  scanned: number // Neon rows loaded
  arkPlusRemoved: number
  circleDrift: number // found, capped — removed only when not a dry run
  circleRemoved: number
  circleDryRun: boolean
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

// Subscription statuses under which a row's SUBSCRIPTION still grants its tier.
// `past_due` is in: that is Stripe's dunning window (Smart Retries, up to a few
// weeks), the member is mid-retry rather than gone, and the webhook deliberately
// keeps their access through it. `unpaid` is out: it is where a subscription
// lands once every retry has FAILED, when the Dashboard is set to leave it open
// rather than cancel it — no `subscription.deleted` ever follows, so without this
// a member who stopped paying kept everything, indefinitely. Anything else
// (canceled, paused, incomplete…) should never be on a subscription row at all,
// and is read as closed if it is.
const SUBSCRIPTION_GRANTING_STATUSES = new Set(['active', 'trialing', 'past_due'])

// How far past `current_period_end` a subscription row keeps granting. The
// period end only lapses when the renewal's `subscription.updated` never reached
// us — Stripe rolls the period forward when it CREATES the renewal invoice, paid
// or not, so a member in dunning is a full period ahead of this check, not
// behind it. A week outlasts Stripe's own three days of webhook retries with
// room for a bad deploy; past it, a row nobody has refreshed is not evidence of
// a paying member. (The reconciler only ever removes, so this is the one place
// a silently-dead subscription stops granting.)
const SUBSCRIPTION_PERIOD_GRACE_MS = 7 * 24 * 60 * 60 * 1000

type AxisRow = {
  tier: Tier
  status: string
  stripe_subscription_id: string | null
  current_period_end: string | null
  ark_plus_gift_expires_at: string | null
  circle_gift_expires_at: string | null
}

// The axes a row's GIFT terms grant right now, on their own — each per-axis
// expiry still in the future. Split out of liveAxes because the webhook needs
// exactly this when a subscription ends: what is left once the subscription's
// half of the row is gone.
export function liveGiftAxes(
  row: Pick<AxisRow, 'ark_plus_gift_expires_at' | 'circle_gift_expires_at'>,
  now: number = Date.now(),
): Entitlements {
  return {
    arkPlus:
      row.ark_plus_gift_expires_at != null && Date.parse(row.ark_plus_gift_expires_at) > now,
    circle:
      row.circle_gift_expires_at != null && Date.parse(row.circle_gift_expires_at) > now,
  }
}

// Whether a row's subscription is still one that grants. Fails CLOSED on both
// signals the row carries: a status outside the granting set, or a period end
// more than the grace behind us. A null period end is not held against the row
// — a subscription event can legitimately carry none (an itemless payload), and
// status still gates it.
function subscriptionGrants(
  row: Pick<AxisRow, 'status' | 'current_period_end'>,
  now: number,
): boolean {
  if (!SUBSCRIPTION_GRANTING_STATUSES.has(row.status)) return false
  if (row.current_period_end == null) return true
  const endsAt = Date.parse(row.current_period_end)
  // Unparseable is unknown, not lapsed: status has already vouched for the row.
  if (!Number.isFinite(endsAt)) return true
  return endsAt + SUBSCRIPTION_PERIOD_GRACE_MS > now
}

// The entitlement axes a membership row grants RIGHT NOW — the union of:
//   - base axes: a row with a live subscription grants its tier's axes (dunning
//     rows still grant; an `unpaid` or long-lapsed one does not — see
//     subscriptionGrants). A row with NO subscription and NO gift term is a comp
//     / staff / legacy grant — perpetual access to its tier (matching the
//     pre-per-axis "non-free tier = live").
//   - gift axes: each per-axis gift expiry still in the future grants that axis.
// A gift-only row has no subscription and at least one gift expiry, so its axes
// come purely from the two gift expiries. This is the single predicate behind the
// resolver's per-request gate and the reconciler's keep-set. Absence of a row =
// free (no axes).
export function liveAxes(row: AxisRow): Entitlements {
  const now = Date.now()
  const hasGift =
    row.ark_plus_gift_expires_at != null || row.circle_gift_expires_at != null
  // Subscription row → its tier, while the subscription still grants; comp/staff
  // row (no sub, no gift) → perpetual its tier; gift-only row → no base axes
  // (gift expiries decide below).
  const base =
    row.stripe_subscription_id != null
      ? subscriptionGrants(row, now)
        ? deriveEntitlements(row.tier)
        : GRANTS.free
      : !hasGift
        ? deriveEntitlements(row.tier)
        : GRANTS.free
  const gift = liveGiftAxes(row, now)
  return {
    arkPlus: base.arkPlus || gift.arkPlus,
    circle: base.circle || gift.circle,
  }
}

// A membership row is live when it still grants at least one axis. Behind both
// the resolver's per-request gate and the reconciler's keep-set.
export function membershipIsLive(row: AxisRow): boolean {
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
    return {
      scanned: 0,
      arkPlusRemoved: 0,
      circleDrift: 0,
      circleRemoved: 0,
      circleDryRun: circleDryRun(env),
      errors: 0,
    }
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
  const circle = await reconcileCircleAxis(
    env,
    circleSubs,
    maxPages,
    batchSize,
  ).catch((err: unknown) => {
    console.error('[reconcile] Circle axis failed:', err)
    errors += 1
    return { drift: 0, removed: 0 }
  })

  return {
    scanned: rows.length,
    arkPlusRemoved,
    circleDrift: circle.drift,
    circleRemoved: circle.removed,
    circleDryRun: circleDryRun(env),
    errors,
  }
}

// The Circle removal pass only acts when explicitly switched on.
function circleDryRun(env: Env): boolean {
  return env.CIRCLE_RECONCILE_ENFORCE !== 'true'
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

// circle drift: remove access-group members whose Neon membership no longer
// grants the circle axis. Like the arkPlus pass, each member's email is
// projected onto Auth0 subs, and a failed or empty projection leaves the member
// alone: that covers anyone added to the group by hand without a site account
// (Circle staff, moderators), and an Auth0 blip. Capped per run. A dry run
// (the default, see circleDryRun) logs what it would remove and removes nothing.
async function reconcileCircleAxis(
  env: Env,
  keep: Set<string>,
  maxPages: number,
  batchSize: number,
): Promise<{ drift: number; removed: number }> {
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return { drift: 0, removed: 0 }

  const members = await listCircleAccessGroupMembers(env, maxPages)
  // Same fail-safe as the arkPlus axis: an empty keep-set against a populated access
  // group means Neon isn't the trustworthy authority yet (unbackfilled / bad
  // read), so skip removal rather than clear the whole community group.
  if (members.length > 0 && keep.size === 0) {
    console.error(
      '[reconcile] Circle keep-set empty but access group non-empty — skipping removal (run the backfill?)',
    )
    return { drift: 0, removed: 0 }
  }

  // Resolve first, remove second, so the cap applies to confirmed drift only.
  const stale: CircleReconcileMember[] = []
  let unresolved = 0
  await batched(members, batchSize, async (m) => {
    if (!m.email) {
      unresolved += 1
      return
    }
    const subs = await fetchAuth0SubsForEmail(env, m.email)
    if (subs === null || subs.length === 0) {
      unresolved += 1
      return
    }
    if (subs.some((sub) => keep.has(sub))) return
    stale.push(m)
  })
  if (unresolved > 0) {
    console.warn(
      `[reconcile] Circle: ${unresolved} group member(s) could not be projected onto a membership row — left alone`,
    )
  }

  const drift = stale.slice(0, CIRCLE_DRIFT_MAX_REMOVE)
  if (stale.length > CIRCLE_DRIFT_MAX_REMOVE) {
    console.warn(
      `[reconcile] Circle drift exceeded cap ${CIRCLE_DRIFT_MAX_REMOVE}; overflow waits for next run`,
    )
  }

  if (circleDryRun(env)) {
    // The community member id is enough to find each one in Circle admin
    // without putting addresses in the logs.
    for (const m of drift) {
      console.warn(
        `[reconcile] Circle dry run: would remove community member ${m.communityMemberId} (${redactEmail(m.email as string)})`,
      )
    }
    return { drift: drift.length, removed: 0 }
  }

  let removed = 0
  await batched(drift, batchSize, async (m) => {
    try {
      // email is non-null here (checked above); the write-address is transient.
      await setCircleAccessGroup(env, m.email as string, false)
      removed += 1
    } catch (err) {
      console.error('[reconcile] Circle remove failed:', err)
    }
  })
  return { drift: drift.length, removed }
}

type CircleReconcileMember = {
  communityMemberId: number
  email: string | null
}

// Project the subscriber access group's roster to { community_member_id, email }.
// The access-group list returns only community_member_id, so we page it, then
// walk the full member roster to resolve each id to its email. Both walks share
// the same maxPages budget.
async function listCircleAccessGroupMembers(
  env: Env,
  maxPages: number,
): Promise<CircleReconcileMember[]> {
  const apiToken = env.CIRCLE_ADMIN_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return []
  const headers = { Authorization: `Bearer ${apiToken}` }

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

  // 2. Resolve ids → email by walking the member roster.
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
