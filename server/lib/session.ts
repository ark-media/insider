// Session resolution. Two token shapes are accepted:
//
//   1. Auth0 RS256 access tokens (the long-term session).
//   2. Our own HS256 `ark_checkout` JWT, issued at the end of checkout so
//      brand-new subscribers can land on /setup before their password-reset
//      email arrives. Lives in an httpOnly cookie or a Bearer header.

import type { IncomingMessage } from 'node:http'
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose'
import { AUTH0_DOMAIN } from '../auth0.js'
import {
  AUTH0_AUDIENCE,
  AUTH0_EMAIL_CLAIM,
  AUTH0_ROLES_CLAIM,
} from '../../shared/auth0-claims.js'
import {
  AUTH_TXN_TTL_SEC,
  CHECKOUT_COOKIE_NAME,
  CHECKOUT_TOKEN_TTL_SEC,
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_TTL_SEC,
  readCookie,
} from './cookies.js'

type Env = Record<string, string>

const CHECKOUT_TOKEN_ISSUER = 'ark-insider'
const CHECKOUT_TOKEN_AUDIENCE = 'checkout-session'

const SESSION_TOKEN_ISSUER = 'ark-insider'
const SESSION_TOKEN_AUDIENCE = 'ark-session'

const AUTH_TXN_ISSUER = 'ark-insider'
const AUTH_TXN_AUDIENCE = 'ark-auth-txn'

const GIFT_CLAIM_ISSUER = 'ark-insider'
const GIFT_CLAIM_AUDIENCE = 'gift-claim'
// A gift is claimable anytime (no redeem-by), but a signed link that both logs
// the recipient in and redeems is a standing credential — bound it to 90 days.
// After that the recipient signs in normally (or asks for a resend) and claims
// via the token-based /redeem fallback.
const GIFT_CLAIM_TTL_SEC = 90 * 24 * 60 * 60

const jwks = createRemoteJWKSet(
  new URL(`${AUTH0_DOMAIN}/.well-known/jwks.json`),
)

export async function verifyAuth0Bearer(token: string): Promise<string | null> {
  const profile = await verifyAuth0BearerProfile(token)
  return profile?.email ?? null
}

export type Auth0Profile = {
  email: string
  name?: string
  // The Auth0 `sub` (user_id) — the standard JWT subject. After the post-login
  // account-linking Action runs setPrimaryUser, this is the post-merge *primary*
  // user_id, which is exactly the key the Neon membership row is stored under
  // (tasks/entitlement-tiers.md §3). Absent only for a malformed token.
  sub?: string
  // `emailVerified` comes from a custom claim; the Auth0 Action must be
  // configured for it to be present. Auth0 no longer carries any entitlement
  // (task 5) — access is a Neon read, never a token claim.
  emailVerified?: boolean
  // Role names from the AUTH0_ROLES_CLAIM (the user's assigned Auth0 RBAC roles,
  // emitted by the Login Action). Empty when the claim is absent — never assume
  // admin from a missing claim.
  roles: string[]
}

// Pulls the roles claim into a clean string[] regardless of how Auth0 encodes
// it (array, or a lone string). Anything else → no roles. Pure, so it's
// unit-tested directly.
export function extractStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string')
  if (typeof raw === 'string' && raw) return [raw]
  return []
}

export function extractRoles(payload: Record<string, unknown>): string[] {
  return extractStrings(payload[AUTH0_ROLES_CLAIM])
}

export function isAdminProfile(profile: Auth0Profile | null): boolean {
  return profile !== null && profile.roles.includes('admin')
}

export async function verifyAuth0BearerProfile(
  token: string,
): Promise<Auth0Profile | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${AUTH0_DOMAIN}/`,
      audience: AUTH0_AUDIENCE,
    })
    const email = payload[AUTH0_EMAIL_CLAIM] as string | undefined
    if (!email) return null
    const verifiedClaim = payload[`${AUTH0_EMAIL_CLAIM}_verified`]
    return {
      email,
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
      name: (payload['name'] as string | undefined) ?? undefined,
      emailVerified:
        verifiedClaim === true || verifiedClaim === false ? verifiedClaim : undefined,
      roles: extractRoles(payload as Record<string, unknown>),
    }
  } catch {
    return null
  }
}

// --- Shared HS256 helpers for our first-party tokens ---------------------
// (checkout, session, and the OAuth transaction all sign/verify the same way,
// differing only in issuer/audience/TTL/payload.)

// All first-party tokens (session w/ admin roles, checkout, OAuth txn) are
// HS256-signed with this key, so a short/low-entropy secret is forgeable —
// a forged `ark_session` with roles:['admin'] is a full back-office takeover.
// Enforce a 32-byte floor at both sign and verify time (verify swallows the
// throw and fails closed; signing surfaces it loudly at mint time).
function hmacKey(secret: string): Uint8Array {
  const key = new TextEncoder().encode(secret)
  if (key.length < 32) {
    throw new Error('HS256 secret must be at least 32 bytes')
  }
  return key
}

function signHs256(
  payload: Record<string, unknown>,
  opts: { issuer: string; audience: string; ttl: string; secret: string },
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setExpirationTime(opts.ttl)
    .sign(hmacKey(opts.secret))
}

async function verifyHs256(
  token: string,
  opts: { issuer: string; audience: string; secret: string | undefined },
): Promise<JWTPayload | null> {
  if (!opts.secret) return null
  try {
    const { payload } = await jwtVerify(token, hmacKey(opts.secret), {
      issuer: opts.issuer,
      audience: opts.audience,
    })
    return payload
  } catch {
    return null
  }
}

export async function verifyCheckoutToken(token: string, env: Env): Promise<string | null> {
  return (await verifyCheckoutProfile(token, env))?.email ?? null
}

// The checkout token's payload: the buyer's email plus, when it was resolved at
// provisioning time, their Auth0 `sub`. The `sub` lets a just-paid member (who
// has no `ark_session` yet) resolve their Neon membership row directly, instead
// of relying only on the SC-by-email arkPlus fallback (§3). Absent when Auth0
// provisioning soft-failed — the SC fallback still covers the arkPlus feed.
export type CheckoutProfile = { email: string; sub: string | null }

export async function verifyCheckoutProfile(
  token: string,
  env: Env,
): Promise<CheckoutProfile | null> {
  const payload = await verifyHs256(token, {
    issuer: CHECKOUT_TOKEN_ISSUER,
    audience: CHECKOUT_TOKEN_AUDIENCE,
    secret: env.CHECKOUT_SESSION_SECRET,
  })
  const email = payload?.email as string | undefined
  if (!email) return null
  return { email, sub: (payload?.sub as string | undefined) ?? null }
}

export async function signCheckoutToken(
  email: string,
  env: Env,
  sub?: string | null,
): Promise<string> {
  const secret = env.CHECKOUT_SESSION_SECRET
  if (!secret) throw new Error('CHECKOUT_SESSION_SECRET not configured')
  return signHs256(
    { email, ...(sub ? { sub } : {}) },
    {
      issuer: CHECKOUT_TOKEN_ISSUER,
      audience: CHECKOUT_TOKEN_AUDIENCE,
      ttl: `${CHECKOUT_TOKEN_TTL_SEC}s`,
      secret,
    },
  )
}

// --- ark_session: the long-term BFF login session ------------------------
//
// Minted by /api/auth/callback after the server-side OAuth exchange (see
// routes/auth.ts) and carried in the httpOnly `ark_session` cookie. We store
// only identity the backend can't cheaply re-derive per request: `roles`
// (admin gate — no live source without a management call), `email`/`name`, and
// the `sub` (the Neon entitlement key). Access is never stored — it's a live
// Neon read on the sub (§2).

export type SessionProfile = {
  email: string
  roles: string[]
  name?: string
  // The Auth0 `sub` (post-merge primary user_id) carried from the verified
  // access token at callback time — the key every Neon entitlement read uses
  // (§3). Stored in the cookie so a gate never needs a Management API round-trip
  // to map the session back to its membership row.
  sub?: string
}

export async function signSessionToken(profile: SessionProfile, env: Env): Promise<string> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET not configured')
  return signHs256(
    {
      email: profile.email,
      roles: profile.roles,
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.sub ? { sub: profile.sub } : {}),
    },
    {
      issuer: SESSION_TOKEN_ISSUER,
      audience: SESSION_TOKEN_AUDIENCE,
      ttl: `${SESSION_TOKEN_TTL_SEC}s`,
      secret,
    },
  )
}

export async function verifySessionToken(token: string, env: Env): Promise<SessionProfile | null> {
  const payload = await verifyHs256(token, {
    issuer: SESSION_TOKEN_ISSUER,
    audience: SESSION_TOKEN_AUDIENCE,
    secret: env.SESSION_SECRET,
  })
  if (!payload?.email) return null
  return {
    email: payload.email as string,
    roles: extractStrings(payload.roles),
    name: (payload.name as string | undefined) ?? undefined,
    sub: (payload.sub as string | undefined) ?? undefined,
  }
}

// --- gift-claim magic link -----------------------------------------------
//
// The single-email gift flow: the recipient's claim email carries one link to
// /redeem?mt=<this token>. Verifying it server-side proves the sender vouched
// for this email (the token is HMAC-signed with SESSION_SECRET), so the claim
// endpoint can create/log-in the recipient and redeem in one click — no Auth0
// redirect, no "verify your email". Self-contained: it carries the recipient's
// email + name and the gift's redemption token, so the `gift` table needs no
// recipient columns.

export type GiftClaimToken = { giftToken: string; email: string; name?: string }

export async function signGiftClaimToken(
  claim: GiftClaimToken,
  env: Env,
): Promise<string> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET not configured')
  return signHs256(
    {
      giftToken: claim.giftToken,
      email: claim.email,
      ...(claim.name ? { name: claim.name } : {}),
    },
    {
      issuer: GIFT_CLAIM_ISSUER,
      audience: GIFT_CLAIM_AUDIENCE,
      ttl: `${GIFT_CLAIM_TTL_SEC}s`,
      secret,
    },
  )
}

export async function verifyGiftClaimToken(
  token: string,
  env: Env,
): Promise<GiftClaimToken | null> {
  const payload = await verifyHs256(token, {
    issuer: GIFT_CLAIM_ISSUER,
    audience: GIFT_CLAIM_AUDIENCE,
    secret: env.SESSION_SECRET,
  })
  const giftToken = payload?.giftToken as string | undefined
  const email = payload?.email as string | undefined
  if (!giftToken || !email) return null
  return { giftToken, email, name: (payload?.name as string | undefined) ?? undefined }
}

// --- ark_auth_txn: the in-flight OAuth transaction -----------------------
//
// Bridges /api/auth/login → /api/auth/callback in an httpOnly cookie: the
// PKCE verifier plus the state/nonce we'll check on return, and where to send
// the user afterwards. Signed (not just opaque) so a tampered cookie is
// rejected rather than silently trusted.

export type AuthTxn = {
  verifier: string
  state: string
  nonce: string
  returnTo: string
}

export async function signAuthTxnToken(txn: AuthTxn, env: Env): Promise<string> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET not configured')
  return signHs256({ ...txn }, {
    issuer: AUTH_TXN_ISSUER,
    audience: AUTH_TXN_AUDIENCE,
    ttl: `${AUTH_TXN_TTL_SEC}s`,
    secret,
  })
}

export async function verifyAuthTxnToken(token: string, env: Env): Promise<AuthTxn | null> {
  const payload = await verifyHs256(token, {
    issuer: AUTH_TXN_ISSUER,
    audience: AUTH_TXN_AUDIENCE,
    secret: env.SESSION_SECRET,
  })
  if (!payload) return null
  const { verifier, state, nonce, returnTo } = payload as Record<string, unknown>
  if (
    typeof verifier !== 'string' ||
    typeof state !== 'string' ||
    typeof nonce !== 'string' ||
    typeof returnTo !== 'string'
  ) {
    return null
  }
  return { verifier, state, nonce, returnTo }
}

// Reads the logged-in session profile from the `ark_session` cookie. Used by
// routes that need roles (admin) or want the tier hint.
export async function getSessionProfile(
  req: IncomingMessage,
  env: Env,
): Promise<SessionProfile | null> {
  const cookieToken = readCookie(req, SESSION_COOKIE_NAME)
  if (!cookieToken) return null
  return verifySessionToken(cookieToken, env)
}

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

// Resolve who is making this request, checking every accepted credential in one
// precedence order: an Auth0 bearer, then the checkout bearer, then the
// ark_session cookie, then the checkout cookie. Null when unauthenticated. The
// single source of request identity — the entitlement resolver and every gate
// resolve through this, and `getSessionEmail` is just its `.email`.
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

export async function getSessionEmail(
  req: IncomingMessage,
  env: Env,
): Promise<string | null> {
  return (await resolveRequestIdentity(req, env))?.email ?? null
}

// Admin gate for the back office. Passes only for a session that carries the
// "admin" role: the `ark_session` login cookie (set after the OAuth exchange,
// so its roles came from a verified Auth0 token) or a raw Auth0 Bearer. The
// short-lived checkout cookie is deliberately not accepted (no roles). Returns
// the profile so the caller can log who acted; null means "not an admin".
export async function requireAdmin(
  req: IncomingMessage,
  env: Env,
): Promise<Auth0Profile | null> {
  const session = await getSessionProfile(req, env)
  if (session && session.roles.includes('admin')) {
    return {
      email: session.email,
      sub: session.sub,
      name: session.name,
      roles: session.roles,
    }
  }
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const profile = await verifyAuth0BearerProfile(authHeader.slice(7))
    if (isAdminProfile(profile)) return profile
  }
  return null
}
