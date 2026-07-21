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
import {
  deriveEntitlements,
  membershipIsLive,
  type Entitlements,
  type Tier,
} from '../entitlement.js'
import { getDb } from './db.js'
import { getMembershipByAuth0Sub, type MembershipRow } from './membership.js'
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

// Resolve entitlements for an already-known identity. `scFallback` opts into the
// transitional SC-by-email arkPlus grant — /api/me passes it during cutover; the
// content gates leave it off and run Neon-only (the backfill populates rows
// before task 10/11 land, so a strict Neon read doesn't false-lock).
export async function resolveMembershipForIdentity(
  identity: RequestIdentity,
  env: Env,
  opts: { scFallback?: boolean } = {},
): Promise<ResolvedMembership> {
  // 1. Neon is the authority: a live row keyed on the caller's sub decides tier.
  if (identity.sub && env.DATABASE_URL) {
    const row = await getMembershipByAuth0Sub(getDb(env), identity.sub)
    if (row && membershipIsLive(row)) {
      return {
        identity,
        tier: row.tier,
        entitlements: deriveEntitlements(row.tier),
        row,
        scUserId: row.sc_user_id,
        origin: 'neon',
      }
    }
  }

  // 2. Transitional SC-only safety net (task 10): a just-paid arkPlus member may
  //    have no row yet (webhook lag) or no sub (checkout token pre-Auth0).
  //    Presence in Supporting Cast grants arkPlus. Removed once the backfill is
  //    verified complete.
  if (opts.scFallback) {
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
  opts: { scFallback?: boolean } = {},
): Promise<ResolvedMembership | null> {
  const identity = await resolveRequestIdentity(req, env)
  if (!identity) return null
  return resolveMembershipForIdentity(identity, env, opts)
}
