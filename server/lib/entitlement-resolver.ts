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
  type Entitlements,
  type Tier,
} from '../entitlement.js'
import { CHECKOUT_COOKIE_NAME, readCookie } from './cookies.js'
import { getDb } from './db.js'
import { getMembershipByAuth0Sub, type MembershipRow } from './membership.js'
import { createScClient, findScUserByEmail, type ScUser } from './sc-client.js'
import {
  getSessionProfile,
  verifyAuth0BearerProfile,
  verifyCheckoutProfile,
} from './session.js'

type Env = Record<string, string>

// The identity behind a request, however it authenticated.
//
//   'auth0'    — a durable login (ark_session cookie or Auth0 bearer). A missing
//                membership row means "free": a logged-in reader with nothing.
//   'checkout' — the short-lived post-payment token. A missing row AND missing
//                SC feed is a provisioning gap, not free — the caller paid.
export type RequestIdentity = {
  email: string
  sub: string | null
  source: 'auth0' | 'checkout'
}

// Resolve who is making this request, checking every accepted credential in the
// same precedence order the routes used before this module centralized it: an
// Auth0 bearer, then the checkout bearer, then the ark_session cookie, then the
// checkout cookie. Null when unauthenticated.
export async function resolveRequestIdentity(
  req: IncomingMessage,
  env: Env,
): Promise<RequestIdentity | null> {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const profile = await verifyAuth0BearerProfile(token)
    if (profile?.email) {
      return { email: profile.email, sub: profile.sub ?? null, source: 'auth0' }
    }
    const checkout = await verifyCheckoutProfile(token, env)
    if (checkout) return { email: checkout.email, sub: checkout.sub, source: 'checkout' }
  }
  const session = await getSessionProfile(req, env)
  if (session) {
    return { email: session.email, sub: session.sub ?? null, source: 'auth0' }
  }
  const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
  if (cookieToken) {
    const checkout = await verifyCheckoutProfile(cookieToken, env)
    if (checkout) return { email: checkout.email, sub: checkout.sub, source: 'checkout' }
  }
  return null
}

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

// A row grants its tier's entitlements unless it's a gift term that has already
// elapsed (the reconciler removes expired gift rows, but a read must not trust a
// stale one). Subscription rows in dunning (past_due / unpaid) still grant —
// Stripe retries within the grace window before a later .deleted revokes.
function rowGrantsEntitlement(row: MembershipRow): boolean {
  if (row.tier === 'free') return false
  if (row.gift_expires_at) return Date.parse(row.gift_expires_at) > Date.now()
  return true
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
    if (row && rowGrantsEntitlement(row)) {
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
