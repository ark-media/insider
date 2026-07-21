// Neon `membership` + `gift` access (migration 0010). Neon is the single
// entitlement authority (tasks/entitlement-tiers.md §3): the webhook writes here
// and every server-side gate reads a resolver over it. Keyed on the Auth0 `sub`
// (opaque, no PII); entitlements are derived from `tier` via GRANTS, never
// stored. Absence of a row = free — no free rows are ever written.

import type { Tier } from '../entitlement.js'
import type { Sql } from './db.js'

export type Plan = 'monthly' | 'yearly'

export type MembershipRow = {
  auth0_sub: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  sc_user_id: number | null
  tier: Tier
  status: string
  plan: string | null
  amount_cents: number | null
  current_period_end: string | null
  cancel_at: string | null
  gift_expires_at: string | null
}

// What the webhook writes for a subscription event. Pending-change columns
// (scheduled_tier etc.) are left to the task-14 switch flow and untouched here.
export type MembershipUpsert = {
  auth0_sub: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  sc_user_id: number | null
  tier: Tier
  status: string
  plan: string | null
  amount_cents: number | null
  current_period_end: string | null
  cancel_at: string | null
  gift_expires_at?: string | null
}

export async function getMembershipByAuth0Sub(
  sql: Sql,
  auth0Sub: string,
): Promise<MembershipRow | null> {
  const rows = await sql`
    select auth0_sub, stripe_customer_id, stripe_subscription_id, sc_user_id,
           tier, status, plan, amount_cents,
           current_period_end, cancel_at, gift_expires_at
    from membership where auth0_sub = ${auth0Sub}`
  return (rows[0] as MembershipRow | undefined) ?? null
}

// Prior-state lookup keyed on the Stripe customer — available straight off the
// event, before we've resolved the Auth0 sub. Used to read `priorTier` for the
// entitlement diff without depending on provisioning having run.
export async function getMembershipByStripeCustomer(
  sql: Sql,
  customerId: string,
): Promise<MembershipRow | null> {
  const rows = await sql`
    select auth0_sub, stripe_customer_id, stripe_subscription_id, sc_user_id,
           tier, status, plan, amount_cents,
           current_period_end, cancel_at, gift_expires_at
    from membership where stripe_customer_id = ${customerId}
    order by updated_at desc limit 1`
  return (rows[0] as MembershipRow | undefined) ?? null
}

// Upsert keyed on auth0_sub. `updated_at` is bumped to now(). gift_expires_at is
// preserved when omitted (a subscription event shouldn't clear a gift term).
export async function upsertMembership(sql: Sql, m: MembershipUpsert): Promise<void> {
  const giftExpires = m.gift_expires_at ?? null
  await sql`
    insert into membership (
      auth0_sub, stripe_customer_id, stripe_subscription_id, sc_user_id,
      tier, status, plan, amount_cents, current_period_end, cancel_at,
      gift_expires_at, updated_at
    ) values (
      ${m.auth0_sub}, ${m.stripe_customer_id}, ${m.stripe_subscription_id}, ${m.sc_user_id},
      ${m.tier}, ${m.status}, ${m.plan}, ${m.amount_cents}, ${m.current_period_end}, ${m.cancel_at},
      ${giftExpires}, now()
    )
    on conflict (auth0_sub) do update set
      stripe_customer_id     = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      sc_user_id             = coalesce(excluded.sc_user_id, membership.sc_user_id),
      tier                   = excluded.tier,
      status                 = excluded.status,
      plan                   = excluded.plan,
      amount_cents           = excluded.amount_cents,
      current_period_end     = excluded.current_period_end,
      cancel_at              = excluded.cancel_at,
      gift_expires_at        = coalesce(excluded.gift_expires_at, membership.gift_expires_at),
      updated_at             = now()`
}

// The whole membership roster, projected to just what the reconciler needs to
// compute per-axis keep-sets (§15). Neon is the authority; the reconciler diffs
// these against the SC roster and the Circle access group.
export type MembershipReconcileRow = {
  auth0_sub: string
  sc_user_id: number | null
  tier: Tier
  status: string
  gift_expires_at: string | null
}

export async function loadAllMemberships(sql: Sql): Promise<MembershipReconcileRow[]> {
  const rows = await sql`
    select auth0_sub, sc_user_id, tier, status, gift_expires_at from membership`
  return rows as MembershipReconcileRow[]
}

// One page of the admin member directory, newest first. The optional tier
// filter runs in SQL; email and activation are resolved outside this query
// (email from Stripe, activation from sc_feed_activations) because Neon stores
// no PII — see server/routes/admin-members.ts. `limit`/`offset` paginate the
// membership spine; pass limit + 1 to detect a next page.
export type MemberDirectoryRow = {
  auth0_sub: string
  stripe_customer_id: string | null
  tier: Tier
  status: string
  current_period_end: string | null
  cancel_at: string | null
  gift_expires_at: string | null
}

export async function listMemberships(
  sql: Sql,
  opts: { tier: Tier | null; limit: number; offset: number },
): Promise<MemberDirectoryRow[]> {
  const rows = await sql`
    select auth0_sub, stripe_customer_id, tier, status,
           current_period_end, cancel_at, gift_expires_at
    from membership
    where (${opts.tier}::text is null or tier = ${opts.tier})
    order by updated_at desc
    limit ${opts.limit} offset ${opts.offset}`
  return rows as MemberDirectoryRow[]
}

// Dunning / status-only update, matched on the Stripe customer (the event may
// carry no membership context beyond it). No-op when no row matches.
export async function setMembershipStatusByCustomer(
  sql: Sql,
  customerId: string,
  status: string,
): Promise<void> {
  await sql`
    update membership set status = ${status}, updated_at = now()
    where stripe_customer_id = ${customerId}`
}

// Record a pending period-end change (a scheduled downgrade / PWYC-lowering),
// keyed on the Stripe customer. The webhook clears these when the schedule
// lands. No-op when no row matches.
export async function setMembershipPending(
  sql: Sql,
  customerId: string,
  pending: {
    scheduled_tier: Tier
    schedule_id: string | null
    pending_amount_cents: number | null
    pending_plan: string | null
  },
): Promise<void> {
  await sql`
    update membership set
      scheduled_tier       = ${pending.scheduled_tier},
      schedule_id          = ${pending.schedule_id},
      pending_amount_cents = ${pending.pending_amount_cents},
      pending_plan         = ${pending.pending_plan},
      updated_at           = now()
    where stripe_customer_id = ${customerId}`
}

// Clear any pending period-end change (an immediate change superseded it, or the
// schedule was released). Matched on the Stripe customer.
export async function clearMembershipPending(
  sql: Sql,
  customerId: string,
): Promise<void> {
  await sql`
    update membership set
      scheduled_tier = null, schedule_id = null,
      pending_amount_cents = null, pending_plan = null, updated_at = now()
    where stripe_customer_id = ${customerId}`
}

// Full cancel/pause on a single-subscription member leaves no remaining
// entitlement, so the row is removed (absence = free). Matched on the customer.
export async function deleteMembershipByCustomer(
  sql: Sql,
  customerId: string,
): Promise<void> {
  await sql`delete from membership where stripe_customer_id = ${customerId}`
}

// Remove provably-expired gift membership rows: a gift is customer-less (no
// Stripe subscription to cancel), so nothing else ever deletes it, and a lapsed
// gift row left at status 'active' makes status-based logic (the gift-redeem
// stacking check) misread it as live. Reads already treat an elapsed
// gift_expires_at as free, so this is pure housekeeping. Returns the count
// removed. Scoped tightly to customer-less rows so a real subscription is never
// touched.
export async function deleteExpiredGiftMemberships(sql: Sql): Promise<number> {
  const rows = await sql`
    delete from membership
    where stripe_customer_id is null
      and gift_expires_at is not null
      and gift_expires_at <= now()
    returning auth0_sub`
  return rows.length
}

// --- Gifts ------------------------------------------------------------------

export type GiftRow = {
  redemption_token: string
  tier: Tier
  plan: string | null
  amount_cents: number | null
  giver_sub: string | null
  status: 'pending' | 'redeemed'
  redeemed_by: string | null
}

// Write a pending gift at purchase time. Idempotent on the token (the webhook
// derives it deterministically from the PaymentIntent, so a retry no-ops).
export async function insertGift(
  sql: Sql,
  g: {
    redemption_token: string
    tier: Tier
    plan: string | null
    amount_cents: number | null
    giver_sub: string | null
  },
): Promise<void> {
  await sql`
    insert into gift (redemption_token, tier, plan, amount_cents, giver_sub, status)
    values (${g.redemption_token}, ${g.tier}, ${g.plan}, ${g.amount_cents}, ${g.giver_sub}, 'pending')
    on conflict (redemption_token) do nothing`
}

export async function getGiftByToken(sql: Sql, token: string): Promise<GiftRow | null> {
  const rows = await sql`
    select redemption_token, tier, plan, amount_cents, giver_sub, status, redeemed_by
    from gift where redemption_token = ${token}`
  return (rows[0] as GiftRow | undefined) ?? null
}

// Flip pending → redeemed, stamping the recipient's Auth0 sub. Returns true only
// if this call performed the transition (row was still pending) — the atomic
// guard against a double-redeem race.
export async function markGiftRedeemed(
  sql: Sql,
  token: string,
  redeemedBy: string,
): Promise<boolean> {
  const rows = await sql`
    update gift set status = 'redeemed', redeemed_by = ${redeemedBy}
    where redemption_token = ${token} and status = 'pending'
    returning redemption_token`
  return rows.length > 0
}
