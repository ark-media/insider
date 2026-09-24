// Request guards composed from the lower-level checks in session.ts/http.ts.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOrigin, makeJsonRes } from './http.js'
import {
  requireAdmin,
  freshLinkPurpose,
  resolveRequestIdentity,
  type Auth0Profile,
  type EmailLinkPurpose,
  type RequestIdentity,
} from './session.js'

type Env = Record<string, string>

// Back-office gate for a mutating request: admin role + same-origin (CSRF).
// On failure it writes the 403 and returns null; on success returns the
// profile. GET requests skip the origin check (reads aren't CSRF-sensitive).
export async function requireAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: Env,
  appBaseUrl: string,
): Promise<Auth0Profile | null> {
  const json = makeJsonRes(res)
  // Everything behind this gate is member data or back-office state. Nothing
  // sets a shared-cache directive on it today; say so explicitly so nothing can.
  res.setHeader('cache-control', 'private, no-store')
  const admin = await requireAdmin(req, env)
  if (!admin) {
    json(403, { error: 'forbidden' })
    return null
  }
  if (req.method !== 'GET' && !isSameOrigin(req, appBaseUrl)) {
    json(403, { error: 'bad_origin' })
    return null
  }
  return admin
}

// Gate for anything that moves money or changes what a member is billed:
// cancelling, reactivating, changing tier, taking a retention offer, replacing
// the card. The caller must have actually signed in (an emailed code or Google).
//
// A session minted from a link in an email, or the post-payment checkout token,
// is not enough. Those prove possession of a URL that sits in an inbox for two
// weeks and passes through mail gateways, forwards and request logs — fine for
// landing on /setup, not for charging the card on file. It is also what makes a
// planted session harmless: someone walked into another account by a crafted
// link can't be led into saving their own card there.
//
// On failure it writes the 401 and returns false. `code: 'reauth_required'` is
// what the client keys on to send the member through sign-in and back
// (src/lib/auth.ts); `error` is the sentence shown if it doesn't.
//
// `acceptFreshLink` is the one exception, and a route must name it: a session
// from an emailed link sent for that purpose, still under EMAIL_LINK_TRUST_SEC
// old (session.ts). Only /api/offer/redeem does, for the welcome-offer email.
// That route only switches the member's own subscription on the card already
// on it, so a planted offer session buys an attacker nothing.
function requireLoginAssurance(
  identity: RequestIdentity,
  res: ServerResponse,
  acceptFreshLink?: EmailLinkPurpose,
): boolean {
  if (identity.assurance === 'login') return true
  if (
    acceptFreshLink &&
    identity.session &&
    freshLinkPurpose(identity.session) === acceptFreshLink
  ) {
    return true
  }
  makeJsonRes(res)(401, {
    ok: false,
    code: 'reauth_required',
    error: 'For your security, please sign in again to make changes to your membership.',
  })
  return false
}

// The opening of every billing mutation: who is this, and did they sign in?
// Writes the 401 (unauthenticated, or reauth_required) and returns null on
// failure; returns the member's email otherwise. One call so a new billing
// route can't authenticate the caller and forget to check how.
export async function requireBillingEmail(
  req: IncomingMessage,
  res: ServerResponse,
  env: Env,
  opts: { acceptFreshLink?: EmailLinkPurpose } = {},
): Promise<string | null> {
  const identity = await resolveRequestIdentity(req, env)
  if (!identity) {
    makeJsonRes(res)(401, { error: 'unauthenticated' })
    return null
  }
  if (!requireLoginAssurance(identity, res, opts.acceptFreshLink)) return null
  return identity.email
}
