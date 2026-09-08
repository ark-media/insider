// The single entitlement resolver. Neon is the authority (§3): every server-side
// gate resolves the caller's identity, reads their membership row keyed on the
// Auth0 `sub`, and derives entitlements from the row's `tier` via GRANTS. There
// is exactly one place that answers "what can this request access," so the three
// authorities that used to disagree by route (SC, Auth0 claim, Stripe) collapse
// to one.
//
// A transitional SC-by-email fallback (opt-in, default off) covers the arkPlus
// axis for a just-paid member whose webhook hasn't written the row yet. It's a
// cutover bridge (task 10) removed once the backfill is verified complete; the
// content gates (task 11) run Neon-only.

import type { IncomingMessage } from 'node:http'
import type Stripe from 'stripe'
import {
  deriveEntitlements,
  liveAxes,
  membershipIsLive,
  tierFromEntitlements,
  type Entitlements,
  type Tier,
} from '../entitlement.js'
import { getDb } from './db.js'
import {
  getMembershipByAuth0Sub,
  getMembershipByStripeCustomer,
  type MembershipRow,
} from './membership.js'
import { createScClient, findScUserByEmail, type ScUser } from './sc-client.js'
import {
  resolveRequestIdentity,
  type RequestIdentity,
} from './session.js'

type Env = Record<string, string>

// `resolveRequestIdentity` (and its `RequestIdentity` type) live in session.ts
// now — the single source of request identity. Re-exported here so the many
// gates that already import identity + entitlement together from this module
// keep one import site.
export { resolveRequestIdentity, type RequestIdentity }

export type ResolvedMembership = {
  identity: RequestIdentity
  tier: Tier
  entitlements: Entitlements
  row: MembershipRow | null
  // The SC join key for feed rendering — from the row, or from the fallback SC
  // lookup. Null when the caller has no SC feed (Circle-only / free).
  scUserId: number | null
  // 'neon' = a live membership row decided it; 'sc-fallback' = the transitional
  // SC-by-email arkPlus grant (no row yet); 'none' = no entitlement resolved.
  origin: 'neon' | 'sc-fallback' | 'none'
}

// Look up the caller's SC user by email (the transitional fallback). Soft-fails
// to null so an SC outage degrades to "no arkPlus" rather than throwing through
// a gate.
async function scUserForEmail(env: Env, email: string): Promise<ScUser | null> {
  try {
    return await findScUserByEmail(createScClient(env), email)
  } catch (err) {
    console.error('[entitlement] SC fallback lookup failed:', err)
    return null
  }
}

// Resolve the caller's Neon membership row by email, via their Stripe customer.
// The membership table is keyed on auth0_sub and holds no email (PII-free, §3),
// so the join runs email → Stripe customer(s) → membership-by-customer. Covers a
// member whose session carries no `sub` (a checkout token minted before Auth0
// provisioning stamped it) — without this, the arkPlus-only SC net below would
// silently downgrade a bundle/circle member to ark-plus. Soft-fails to null so a
// Stripe outage degrades to that net rather than throwing through /api/me.
async function membershipByEmailViaStripe(
  stripe: Stripe,
  env: Env,
  email: string,
): Promise<MembershipRow | null> {
  try {
    // Checkout mints a Customer per session, so one email can map to several
    // (churn-then-resubscribe); return the first that carries a live row.
    const customers = await stripe.customers.list({ email, limit: 100 })
    for (const customer of customers.data) {
      const row = await getMembershipByStripeCustomer(getDb(env), customer.id)
      if (row && membershipIsLive(row)) return row
    }
    return null
  } catch (err) {
    console.error('[entitlement] Stripe-by-email membership lookup failed:', err)
    return null
  }
}

// Resolve entitlements for an already-known identity. `scFallback` opts into the
// transitional by-email nets — /api/me passes it during cutover; the content
// gates leave it off and run Neon-only (the backfill populates rows before task
// 10/11 land, so a strict Neon read doesn't false-lock). `stripe`, when given,
// enables the true-tier by-email lookup so bundle/circle members with a sub-less
// session resolve to their real tier instead of the arkPlus-only SC fallback.
export async function resolveMembershipForIdentity(
  identity: RequestIdentity,
  env: Env,
  opts: { scFallback?: boolean; stripe?: Stripe | null } = {},
): Promise<ResolvedMembership> {
  // 1. Neon is the authority: a live row keyed on the caller's sub decides tier.
  if (identity.sub && env.DATABASE_URL) {
    const row = await getMembershipByAuth0Sub(getDb(env), identity.sub)
    if (row && membershipIsLive(row)) {
      // Effective tier is the UNION of the subscription and any live gift axes
      // (D4): an Ark+ subscriber with a live Fold gift resolves to bundle.
      const axes = liveAxes(row)
      return {
        identity,
        tier: tierFromEntitlements(axes),
        entitlements: axes,
        row,
        scUserId: row.sc_user_id,
        origin: 'neon',
      }
    }
  }

  // 2. Transitional by-email nets (task 10), for a just-paid member whose session
  //    carries no sub (checkout token pre-Auth0) or whose row hasn't landed yet.
  if (opts.scFallback) {
    // 2a. True-tier: find the Neon row via the member's Stripe customer, keyed on
    //     the verified session email. Still a Neon read (the authority) — it just
    //     reaches the row by customer instead of sub — so bundle/circle members
    //     resolve to their real tier, not the arkPlus-only net below.
    if (opts.stripe && env.DATABASE_URL) {
      const row = await membershipByEmailViaStripe(opts.stripe, env, identity.email)
      if (row) {
        const axes = liveAxes(row)
        return {
          identity,
          tier: tierFromEntitlements(axes),
          entitlements: axes,
          row,
          scUserId: row.sc_user_id,
          origin: 'neon',
        }
      }
    }

    // 2b. SC-only safety net: presence in Supporting Cast grants arkPlus. Covers
    //     the webhook-lag window where the feed exists but no row is written yet.
    //     Removed once the backfill is verified complete.
    const user = await scUserForEmail(env, identity.email)
    if (user) {
      return {
        identity,
        tier: 'ark-plus',
        entitlements: deriveEntitlements('ark-plus'),
        row: null,
        scUserId: user.id,
        origin: 'sc-fallback',
      }
    }
  }

  return {
    identity,
    tier: 'free',
    entitlements: deriveEntitlements('free'),
    row: null,
    scUserId: null,
    origin: 'none',
  }
}

// Resolve entitlements straight from a request. Null when unauthenticated.
export async function resolveMembership(
  req: IncomingMessage,
  env: Env,
  opts: { scFallback?: boolean; stripe?: Stripe | null } = {},
): Promise<ResolvedMembership | null> {
  const identity = await resolveRequestIdentity(req, env)
  if (!identity) return null
  return resolveMembershipForIdentity(identity, env, opts)
}

// Resolve entitlements from an Auth0 `sub` alone — no request, no session, no
// email. The Circle SSO login gate (server/routes/circle-gate.ts) is the only
// caller: the Auth0 post-login Action asks about a user *mid-login*, so there is
// no request here to resolve an identity from, and none of the by-email cutover
// nets above apply — the Action's own signup gate has already proved a Database
// account exists for this person, so a missing row means "free", not "unknown".
//
// Deliberately routed through liveAxes / tierFromEntitlements rather than
// re-deriving: the tier -> entitlement map lives in exactly one place
// (entitlement.ts GRANTS), so the login gate can never disagree with the content
// gates about what a tier grants. That is the whole reason the Action calls this
// service instead of reading Neon itself.
//
// Throws when Neon is unconfigured rather than answering 'free': the caller maps
// that to a 500, which the Action treats as "couldn't check" (retry) rather than
// "not entitled" (upsell). Answering 'free' here would silently lock the whole
// the Fold out of SSO the moment DATABASE_URL went missing.
export async function resolveEntitlementsForSub(
  sub: string,
  env: Env,
): Promise<{ tier: Tier; entitlements: Entitlements }> {
  if (!env.DATABASE_URL) {
    throw new Error('resolveEntitlementsForSub requires DATABASE_URL')
  }
  const row = await getMembershipByAuth0Sub(getDb(env), sub)
  if (!row || !membershipIsLive(row)) {
    return { tier: 'free', entitlements: deriveEntitlements('free') }
  }
  const axes = liveAxes(row)
  return { tier: tierFromEntitlements(axes), entitlements: axes }
}
