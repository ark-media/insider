// Session resolution. Two token shapes are accepted:
//
//   1. Auth0 RS256 access tokens (the long-term session).
//   2. Our own HS256 `ark_checkout` JWT, issued at the end of checkout so
//      brand-new subscribers can land on /setup before their password-reset
//      email arrives. Lives in an httpOnly cookie or a Bearer header.

import type { IncomingMessage } from 'node:http'
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose'
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
  readCookie,
} from './cookies.js'

type Env = Record<string, string>

const CHECKOUT_TOKEN_ISSUER = 'ark-insider'
const CHECKOUT_TOKEN_AUDIENCE = 'checkout-session'

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
  tier?: 'subscriber' | 'free'
  emailVerified?: boolean
  // Roles from the app_metadata.roles claim. Empty when the claim is absent —
  // never assume admin from a missing claim.
  roles: string[]
}

// Pulls the roles claim into a clean string[] regardless of how Auth0 encodes
// it (array, or a lone string). Anything else → no roles. Pure, so it's
// unit-tested directly.
export function extractRoles(payload: Record<string, unknown>): string[] {
  const raw = payload[AUTH0_ROLES_CLAIM]
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string')
  if (typeof raw === 'string' && raw) return [raw]
  return []
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
      tier: tier === 'subscriber' || tier === 'free' ? tier : undefined,
      emailVerified:
        verifiedClaim === true || verifiedClaim === false ? verifiedClaim : undefined,
      roles: extractRoles(payload as Record<string, unknown>),
    }
  } catch {
    return null
  }
}

export async function verifyCheckoutToken(
  token: string,
  env: Env,
): Promise<string | null> {
  const secret = env.CHECKOUT_SESSION_SECRET
  if (!secret) return null
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      {
        issuer: CHECKOUT_TOKEN_ISSUER,
        audience: CHECKOUT_TOKEN_AUDIENCE,
      },
    )
    return (payload.email as string | undefined) ?? null
  } catch {
    return null
  }
}

export async function signCheckoutToken(email: string, env: Env): Promise<string> {
  const secret = env.CHECKOUT_SESSION_SECRET
  if (!secret) throw new Error('CHECKOUT_SESSION_SECRET not configured')
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(CHECKOUT_TOKEN_ISSUER)
    .setAudience(CHECKOUT_TOKEN_AUDIENCE)
    .setExpirationTime(`${CHECKOUT_TOKEN_TTL_SEC}s`)
    .sign(new TextEncoder().encode(secret))
}

export async function getSessionEmail(
  req: IncomingMessage,
  env: Env,
): Promise<string | null> {
  // Bearer token wins (the authoritative long-term session). Cookie is the
  // fallback for the brief auto-login window after checkout.
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const email =
      (await verifyAuth0Bearer(token)) ??
      (await verifyCheckoutToken(token, env))
    if (email) return email
  }
  const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
  if (cookieToken) return verifyCheckoutToken(cookieToken, env)
  return null
}

// Admin gate for the back office. Only a verified Auth0 access token with the
// "admin" role passes — the short-lived checkout cookie is deliberately not
// accepted (it carries no roles, and admins always log in via Auth0). Returns
// the profile so the caller can log who acted; null means "not an admin".
export async function requireAdmin(req: IncomingMessage): Promise<Auth0Profile | null> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  const profile = await verifyAuth0BearerProfile(authHeader.slice(7))
  return isAdminProfile(profile) ? profile : null
}
