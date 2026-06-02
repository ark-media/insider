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
  AUTH0_TIER_CLAIM,
} from '../../shared/auth0-claims.js'
import {
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
  // `tier` and `emailVerified` come from custom claims; the Auth0 Action must
  // be configured for them to be present. Callers should treat missing values
  // as unknown (not as a safe default).
  tier?: 'ark-plus-member' | 'free'
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
    const tier = payload[AUTH0_TIER_CLAIM]
    const verifiedClaim = payload[`${AUTH0_EMAIL_CLAIM}_verified`]
    return {
      email,
      name: (payload['name'] as string | undefined) ?? undefined,
      tier: tier === 'ark-plus-member' || tier === 'free' ? tier : undefined,
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
  const payload = await verifyHs256(token, {
    issuer: CHECKOUT_TOKEN_ISSUER,
    audience: CHECKOUT_TOKEN_AUDIENCE,
    secret: env.CHECKOUT_SESSION_SECRET,
  })
  return (payload?.email as string | undefined) ?? null
}

export async function signCheckoutToken(email: string, env: Env): Promise<string> {
  const secret = env.CHECKOUT_SESSION_SECRET
  if (!secret) throw new Error('CHECKOUT_SESSION_SECRET not configured')
  return signHs256(
    { email },
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
// (admin gate — no live source without a management call) and `email`/`name`.
// `tier` is a hint only — /api/me always re-checks Simplecast, the authority.

export type SessionProfile = {
  email: string
  roles: string[]
  name?: string
  tier?: 'ark-plus-member' | 'free'
}

export async function signSessionToken(profile: SessionProfile, env: Env): Promise<string> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET not configured')
  return signHs256(
    {
      email: profile.email,
      roles: profile.roles,
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.tier ? { tier: profile.tier } : {}),
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
    tier:
      payload.tier === 'ark-plus-member' || payload.tier === 'free'
        ? payload.tier
        : undefined,
  }
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
    ttl: '10m',
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

export async function getSessionEmail(
  req: IncomingMessage,
  env: Env,
): Promise<string | null> {
  // Bearer token wins (kept for any token-bearing caller). Then the long-term
  // `ark_session` login cookie, then the short-lived post-checkout cookie.
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const email =
      (await verifyAuth0Bearer(token)) ??
      (await verifyCheckoutToken(token, env))
    if (email) return email
  }
  const session = await getSessionProfile(req, env)
  if (session) return session.email
  const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
  if (cookieToken) return verifyCheckoutToken(cookieToken, env)
  return null
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
      name: session.name,
      tier: session.tier,
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
