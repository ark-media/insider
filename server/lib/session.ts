// Session resolution. Two token shapes are accepted:
//
//   1. Auth0 RS256 access tokens (the long-term session).
//   2. Our own HS256 `ark_checkout` JWT, issued at the end of checkout so
//      brand-new subscribers can land on /setup before the welcome email's
//      auto-login link is opened. Lives in an httpOnly cookie or a Bearer header.

import type { IncomingMessage } from 'node:http'
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose'
import { AUTH0_DOMAIN, getManagementClient } from '../auth0.js'
import {
  AUTH0_AUDIENCE,
  AUTH0_EMAIL_CLAIM,
  AUTH0_FAMILY_NAME_CLAIM,
  AUTH0_GIVEN_NAME_CLAIM,
  AUTH0_NAME_SET_BY_MEMBER_CLAIM,
  AUTH0_ROLES_CLAIM,
} from '../../shared/auth0-claims.js'
import { displayName, greetingFirstName } from '../../shared/profile-name.js'
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
// the recipient in and redeems is a standing credential — so its lifetime should
// be the delivery window, not the gift's. 90 days meant an unclicked link sat
// live in an inbox (and in any analytics/log that captured the URL) for a
// quarter. After expiry the recipient signs in normally (or asks for a resend)
// and claims via the token-based /redeem fallback — the gift itself is
// unaffected.
const GIFT_CLAIM_TTL_SEC = 14 * 24 * 60 * 60

const jwks = createRemoteJWKSet(
  new URL(`${AUTH0_DOMAIN}/.well-known/jwks.json`),
)

export type Auth0Profile = {
  email: string
  // Derived from givenName/familyName below, and undefined whenever the stored
  // name is one we manufactured from the email — see shared/profile-name.ts.
  name?: string
  givenName?: string
  familyName?: string
  // Provenance for the name above — see AUTH0_NAME_SET_BY_MEMBER_CLAIM.
  nameSetByMember?: boolean
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
    // Namespaced claims emitted by the Login Action. Auth0 drops
    // non-namespaced custom claims, so a bare `name` would always be undefined.
    const givenName = (payload[AUTH0_GIVEN_NAME_CLAIM] as string | undefined) ?? undefined
    const familyName =
      (payload[AUTH0_FAMILY_NAME_CLAIM] as string | undefined) ?? undefined
    const nameSetByMember = payload[AUTH0_NAME_SET_BY_MEMBER_CLAIM] === true
    return {
      email,
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
      givenName,
      familyName,
      nameSetByMember,
      name: displayName({ givenName, familyName, email, setByMember: nameSetByMember }),
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
      // jose already refuses anything but HS* for a byte key; pinned so the
      // accepted algorithm is stated here rather than inferred from the key type.
      algorithms: ['HS256'],
    })
    return payload
  } catch {
    return null
  }
}

// Which secret signs a given class of token. Each class has its own optional
// env var and falls back to SESSION_SECRET when that is unset.
//
// They all used to share SESSION_SECRET outright, which is fine until the day it
// has to be rotated. Sessions are stateless, so rotating the key is the only way
// to kill them — and with one key that also voided every unclaimed gift link and
// every auto-login link sitting in an inbox. Separate keys make "sign everyone
// out" a thing you can do without breaking mail already sent. Audiences keep the
// classes from being confused with each other either way; this is about
// rotation, not forgery.
type TokenPurpose = 'AUTH_TXN_SECRET' | 'GIFT_CLAIM_SECRET' | 'EMAIL_LOGIN_SECRET'

function secretFor(env: Env, purpose: TokenPurpose): string | undefined {
  return env[purpose] || env.SESSION_SECRET
}

export async function verifyCheckoutToken(token: string, env: Env): Promise<string | null> {
  return (await verifyCheckoutProfile(token, env))?.email ?? null
}

// The checkout token's payload: the buyer's email plus, when it was resolved at
// provisioning time, their Auth0 `sub`. The `sub` lets a just-paid member (who
// has no `ark_session` yet) resolve their Neon membership row directly, instead
// of relying only on the by-email net (§3). Absent when Auth0 provisioning
// soft-failed — the by-email net still covers the arkPlus feed.
type CheckoutProfile = { email: string; sub: string | null }

async function verifyCheckoutProfile(
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
  // Carried so /api/me can greet by first name without a Management API read.
  // Only refreshed at login, so PUT /api/account/profile re-mints this cookie —
  // otherwise an edit wouldn't show until the next sign-in. The full display
  // name is derived (sessionName) rather than stored a third time.
  givenName?: string
  familyName?: string
  // Provenance for the name above (shared/profile-name): true when the member
  // typed it, which is the only thing that lets us greet by a lowercase first
  // name that happens to match their email local part. Mirrored from Auth0
  // app_metadata — immediately by the profile save's cookie re-mint, and at
  // login by the Login Action's claim.
  nameSetByMember?: boolean
  // The Auth0 `sub` (post-merge primary user_id) carried from the verified
  // access token at callback time — the key every Neon entitlement read uses
  // (§3). Stored in the cookie so a gate never needs a Management API round-trip
  // to map the session back to its membership row.
  sub?: string
  // How this session was established. Absent for a real login (an emailed code
  // or Google, through Auth0). 'email_link' for one minted from a link in a
  // lifecycle email or a gift claim: those links sit in an inbox for two weeks,
  // get forwarded, and pass through mail gateways and request logs, so holding
  // one proves much less than typing a fresh code does. Such a session reads and
  // sets up feeds like any other; it cannot move money — see `assurance` on
  // RequestIdentity and requireLoginAssurance in guards.ts.
  via?: 'email_link'
  // Epoch seconds at which the emailed link behind an 'email_link' session was
  // signed — when the email went out, not when it was clicked. A link this
  // fresh is trusted like a sign-in (EMAIL_LINK_TRUST_SEC); an older one is
  // not. Carried across re-mints like loginAt.
  linkIssuedAt?: number
  // Epoch seconds of the login this session descends from. A profile save
  // re-mints the cookie with a fresh 7-day expiry, so without this a stolen
  // cookie could be renewed forever by saving the profile once a week. Carried
  // across re-mints and checked against SESSION_ABSOLUTE_MAX_SEC on verify.
  loginAt?: number
}

// The longest a session can live however often it is re-minted. After this the
// member signs in again.
const SESSION_ABSOLUTE_MAX_SEC = 30 * 24 * 60 * 60

export async function signSessionToken(profile: SessionProfile, env: Env): Promise<string> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET not configured')
  return signHs256(
    {
      email: profile.email,
      roles: profile.roles,
      ...(profile.givenName ? { given_name: profile.givenName } : {}),
      ...(profile.familyName ? { family_name: profile.familyName } : {}),
      ...(profile.nameSetByMember ? { name_set_by_member: true } : {}),
      ...(profile.sub ? { sub: profile.sub } : {}),
      ...(profile.via ? { via: profile.via } : {}),
      ...(profile.linkIssuedAt ? { link_iat: profile.linkIssuedAt } : {}),
      login_at: profile.loginAt ?? Math.floor(Date.now() / 1000),
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
  // `iat` stands in for sessions minted before login_at existed; it is reset by
  // a re-mint, so it only ever errs toward a longer life, and only for those.
  const loginAt =
    typeof payload.login_at === 'number'
      ? payload.login_at
      : typeof payload.iat === 'number'
        ? payload.iat
        : undefined
  if (loginAt !== undefined && Date.now() / 1000 - loginAt > SESSION_ABSOLUTE_MAX_SEC) {
    return null
  }
  return {
    email: payload.email as string,
    roles: extractStrings(payload.roles),
    givenName: (payload.given_name as string | undefined) ?? undefined,
    familyName: (payload.family_name as string | undefined) ?? undefined,
    nameSetByMember: payload.name_set_by_member === true,
    sub: (payload.sub as string | undefined) ?? undefined,
    ...(payload.via === 'email_link' ? { via: 'email_link' as const } : {}),
    ...(typeof payload.link_iat === 'number' ? { linkIssuedAt: payload.link_iat } : {}),
    ...(loginAt !== undefined ? { loginAt } : {}),
  }
}

// The session's full display name, or undefined when no real name is held.
// Derived rather than carried in the cookie so there is exactly one
// representation of a member's name and it can't drift from its parts.
export function sessionName(session: SessionProfile): string | undefined {
  return displayName({
    givenName: session.givenName,
    familyName: session.familyName,
    email: session.email,
    setByMember: session.nameSetByMember,
  })
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

// `tier` is display-only: the redeem page reads it (unverified) to name the gift
// in its heading. Redemption never trusts it — the gift row is the authority.
export type GiftClaimToken = {
  giftToken: string
  email: string
  name?: string
  tier?: string
  // When the claim email was signed (the token's `iat`). Read on verify only,
  // for the session the claim mints (SessionProfile.linkIssuedAt).
  issuedAt?: number
}

export async function signGiftClaimToken(
  claim: GiftClaimToken,
  env: Env,
): Promise<string> {
  const secret = secretFor(env, 'GIFT_CLAIM_SECRET')
  if (!secret) throw new Error('SESSION_SECRET not configured')
  return signHs256(
    {
      giftToken: claim.giftToken,
      email: claim.email,
      ...(claim.name ? { name: claim.name } : {}),
      ...(claim.tier ? { tier: claim.tier } : {}),
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
    secret: secretFor(env, 'GIFT_CLAIM_SECRET'),
  })
  const giftToken = payload?.giftToken as string | undefined
  const email = payload?.email as string | undefined
  if (!giftToken || !email) return null
  return {
    giftToken,
    email,
    name: (payload?.name as string | undefined) ?? undefined,
    issuedAt: typeof payload?.iat === 'number' ? payload.iat : undefined,
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
  const secret = secretFor(env, 'AUTH_TXN_SECRET')
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
    secret: secretFor(env, 'AUTH_TXN_SECRET'),
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
//                feed is a provisioning gap, not free — the caller paid.
export type RequestIdentity = {
  email: string
  sub: string | null
  source: 'auth0' | 'checkout'
  // How strongly the caller has proven they own `email`.
  //   'login' — they signed in: an emailed code or Google, through Auth0.
  //   'link'  — they hold a link we sent (a lifecycle email, a gift claim)
  //             more than EMAIL_LINK_TRUST_SEC old, or the post-payment token,
  //             whose email was typed and never proven.
  // A link inside that window counts as 'login': it proves the same thing an
  // emailed code does — the member reads that inbox — and the member who
  // clicks the offer email on the day can take it in one click.
  // Reading, feed setup and profile edits accept either. Anything that moves
  // money or changes what the member is billed requires 'login'
  // (requireLoginAssurance, guards.ts).
  assurance: 'login' | 'link'
  // The name to greet this person by, or null whenever we hold no name a human
  // gave us — including for the checkout token, which carries no name at all.
  // Callers greet by this or fall back; they must never substitute the email.
  firstName: string | null
  // The verified ark_session, present only when that cookie is how this request
  // authenticated. Carried because resolving the identity already parsed and
  // HMAC-verified it: a caller that needs the rest of the session (the profile
  // save re-mints the cookie, which needs `roles`) would otherwise do the whole
  // verification a second time.
  session?: SessionProfile
}

// Resolve who is making this request, checking every accepted credential in one
// precedence order: an Auth0 bearer, then the checkout bearer, then the
// ark_session cookie, then the checkout cookie. Null when unauthenticated. The
// single source of request identity — the entitlement resolver and every gate
// resolve through this, and `getSessionEmail` is just its `.email`.
// The greeting name for a RequestIdentity, derived once so the bearer and cookie
// paths can't drift. Runs through shared/profile-name, so a name we manufactured
// from the email resolves to null rather than leaking into a greeting. The
// checkout token carries no name at all, hence NO_NAME.
const NO_NAME = { firstName: null } as const

function identityName(profile: {
  email: string
  givenName?: string
  familyName?: string
  nameSetByMember?: boolean
}): Pick<RequestIdentity, 'firstName'> {
  const { email, givenName, familyName, nameSetByMember } = profile
  return {
    firstName:
      greetingFirstName(givenName, email, familyName, nameSetByMember) ?? null,
  }
}

// How long after an email goes out its auto-login link counts as a real
// sign-in. Measured from when the link was signed, so a link opened a week
// later gets the ordinary link session. 48 hours covers the day an email is
// read, and the next.
export const EMAIL_LINK_TRUST_SEC = 48 * 60 * 60

// A session from an emailed link counts as a sign-in while that link is fresh.
// A link session with no issue time (minted before linkIssuedAt existed) is
// treated as stale.
function sessionAssurance(
  session: SessionProfile,
  nowSec = Date.now() / 1000,
): RequestIdentity['assurance'] {
  if (session.via !== 'email_link') return 'login'
  const issuedAt = session.linkIssuedAt
  return issuedAt !== undefined && nowSec - issuedAt <= EMAIL_LINK_TRUST_SEC
    ? 'login'
    : 'link'
}

export async function resolveRequestIdentity(
  req: IncomingMessage,
  env: Env,
): Promise<RequestIdentity | null> {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const profile = await verifyAuth0BearerProfile(token)
    // An address Auth0 says is UNverified proves nothing about who holds it, and
    // the by-email entitlement net trusts this email. Every login the tenant
    // allows today is verified (Google, an emailed code; signups are closed), so
    // this refuses nothing real — it is here for the day a connection changes.
    if (profile?.email && profile.emailVerified !== false) {
      return {
        email: profile.email,
        sub: profile.sub ?? null,
        source: 'auth0',
        assurance: 'login',
        ...identityName(profile),
      }
    }
    const checkout = await verifyCheckoutProfile(token, env)
    if (checkout) {
      return {
        email: checkout.email,
        sub: checkout.sub,
        source: 'checkout',
        assurance: 'link',
        ...NO_NAME,
      }
    }
  }
  const session = await getSessionProfile(req, env)
  if (session) {
    return {
      email: session.email,
      sub: session.sub ?? null,
      source: 'auth0',
      assurance: sessionAssurance(session),
      ...identityName(session),
      session,
    }
  }
  const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
  if (cookieToken) {
    const checkout = await verifyCheckoutProfile(cookieToken, env)
    if (checkout) {
      return {
        email: checkout.email,
        sub: checkout.sub,
        source: 'checkout',
        assurance: 'link',
        ...NO_NAME,
      }
    }
  }
  return null
}

export async function getSessionEmail(
  req: IncomingMessage,
  env: Env,
): Promise<string | null> {
  return (await resolveRequestIdentity(req, env))?.email ?? null
}

// --- live admin-role revocation ------------------------------------------
//
// `roles` is snapshotted into the session cookie at login and the cookie is a
// stateless JWT valid for SESSION_TOKEN_TTL_SEC (7 days) with no server-side
// store to revoke. Left alone, that means removing someone's admin role in
// Auth0 — offboarding, or responding to a compromised account — has no effect
// for up to a week, and signing them out doesn't help either since logout only
// clears the cookie and the token itself stays valid.
//
// So re-check the role against Auth0 before honoring it. Cached briefly: the
// back office fires several requests per screen and none of them should cost a
// Management API round-trip.
const ADMIN_ROLE_TTL_MS = 60_000
const adminRoleCache = new Map<string, { isAdmin: boolean; at: number }>()

// Exported for tests, which need a clean slate between cases.
export function __resetAdminRoleCacheForTests(): void {
  adminRoleCache.clear()
}

// Does Auth0 still say this user is an admin?
//
// Failure semantics, deliberately asymmetric:
//   - A definitive answer is authoritative, including a definitive "no" — that
//     is the revocation this exists for.
//   - No Management credentials returns 'unconfigured'. Callers fall back to the
//     cookie's claim: that is a deployment state, not something a caller can
//     induce, and denying would lock the back office out of every environment
//     that has no M2M client. The launch checklist requires the credentials.
//   - A FAILED lookup returns 'error', and what that means depends on what we
//     last knew. If Auth0 has already told this instance the role is gone, it
//     stays gone: a revoked admin must not get back in by retrying until a
//     lookup happens to 429 or time out, which the old "unknown → trust the
//     cookie" rule allowed. Otherwise the caller decides — reads ride out an
//     Auth0 blip on the cookie's claim, writes do not (see requireAdmin).
type LiveAdmin = boolean | 'unconfigured' | 'error'

async function auth0SaysAdmin(sub: string, env: Env): Promise<LiveAdmin> {
  const hit = adminRoleCache.get(sub)
  if (hit && Date.now() - hit.at < ADMIN_ROLE_TTL_MS) return hit.isAdmin

  const mgmt = getManagementClient(env)
  if (!mgmt) {
    console.warn(
      '[session] no Management credentials — admin role served from the session cookie, revocation will lag until it expires',
    )
    return 'unconfigured'
  }
  try {
    const page = await mgmt.users.roles.list(sub)
    const isAdmin = page.data.some((r: { name?: string }) => r.name === 'admin')
    adminRoleCache.set(sub, { isAdmin, at: Date.now() })
    return isAdmin
  } catch (err) {
    console.error('[session] live admin role lookup failed:', err)
    // A stale "no" outlives its TTL for exactly this case.
    if (hit && !hit.isAdmin) return false
    return 'error'
  }
}

// Whether a claimed admin role survives the live check. Reads tolerate a failed
// lookup; anything that changes state does not — minting a coupon or exporting
// the member list on the strength of a week-old cookie, at the one moment Auth0
// can't confirm it, is the wrong way round.
async function adminRoleHolds(
  sub: string | undefined,
  req: IncomingMessage,
  env: Env,
): Promise<boolean> {
  // Every real login carries a sub (the callback reads it off the verified
  // token). A role claim with no subject can't be re-checked, so it isn't honored.
  if (!sub) return false
  const live = await auth0SaysAdmin(sub, env)
  if (live === false) {
    console.warn('[session] rejecting session whose admin role was revoked:', sub)
    return false
  }
  if (live === 'error') {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      console.warn('[session] admin role unconfirmed (Auth0 lookup failed); refusing a write:', sub)
      return false
    }
  }
  return true
}

// Admin gate for the back office. Passes only for a session that carries the
// "admin" role: the `ark_session` login cookie (set after the OAuth exchange,
// so its roles came from a verified Auth0 token) or a raw Auth0 Bearer. The
// short-lived checkout cookie is deliberately not accepted (no roles). Returns
// the profile so the caller can log who acted; null means "not an admin".
//
// The cookie's claim is necessary but not sufficient — it is re-checked against
// Auth0 (see auth0SaysAdmin) so a revoked admin loses access within a minute
// rather than at cookie expiry.
export async function requireAdmin(
  req: IncomingMessage,
  env: Env,
): Promise<Auth0Profile | null> {
  const session = await getSessionProfile(req, env)
  if (session && session.roles.includes('admin')) {
    if (!(await adminRoleHolds(session.sub, req, env))) return null
    return {
      email: session.email,
      sub: session.sub,
      name: sessionName(session),
      roles: session.roles,
    }
  }
  // A raw Auth0 access token. The browser never holds one (the BFF keeps it
  // server-side), so this is tooling only — and it gets the same live check as
  // the cookie. It used to be trusted for the token's whole lifetime, which made
  // a leaked admin token outlive the role's removal.
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const profile = await verifyAuth0BearerProfile(authHeader.slice(7))
    if (profile && isAdminProfile(profile)) {
      if (!(await adminRoleHolds(profile.sub, req, env))) return null
      return profile
    }
  }
  return null
}

// --- email auto-login link -----------------------------------------------
//
// Lifecycle emails (welcome, axis-added, feed reminders, feed migration) point
// members at pages that require a session — /setup most of all. The recipient
// usually opens them on a device that has never held an `ark_session` cookie,
// so without this the link lands them on a sign-in wall at best. The link
// therefore carries `?lt=<this token>`; /api/auth/email-login verifies it,
// mints the same session the OAuth callback would, and 302s on to the
// destination with the token stripped from the URL.
//
// Deliberately NOT a bearer of anything but identity: it re-states the email
// and Auth0 sub we already resolved when sending, and grants no roles. Admin
// is never conferred by an emailed link — an admin who clicks one gets an
// ordinary member session and signs in normally for /admin.
//
// Same 14-day lifetime as the gift claim link, and for the same reason: this is
// a standing credential sitting in an inbox, so its life is the delivery
// window, not the membership's. After that the route falls through to the
// normal Auth0 login carrying the same destination as returnTo, so an expired
// link still gets the member where they were going — just with a sign-in step.
const EMAIL_LOGIN_ISSUER = 'ark-insider'
const EMAIL_LOGIN_AUDIENCE = 'email-login'
const EMAIL_LOGIN_TTL_SEC = 14 * 24 * 60 * 60

export type EmailLoginToken = {
  email: string
  // The Auth0 `sub`, when provisioning resolved one. Carried so the minted
  // session can read the member's Neon row by sub like every other login path;
  // absent, the by-email net still covers it.
  sub?: string
  givenName?: string
  familyName?: string
  // When the link was signed (the token's `iat`). Read on verify only, for the
  // session the link mints (SessionProfile.linkIssuedAt).
  issuedAt?: number
}

export async function signEmailLoginToken(
  claim: EmailLoginToken,
  env: Env,
): Promise<string> {
  const secret = secretFor(env, 'EMAIL_LOGIN_SECRET')
  if (!secret) throw new Error('SESSION_SECRET not configured')
  return signHs256(
    {
      email: claim.email,
      ...(claim.sub ? { sub: claim.sub } : {}),
      ...(claim.givenName ? { given_name: claim.givenName } : {}),
      ...(claim.familyName ? { family_name: claim.familyName } : {}),
    },
    {
      issuer: EMAIL_LOGIN_ISSUER,
      audience: EMAIL_LOGIN_AUDIENCE,
      ttl: `${EMAIL_LOGIN_TTL_SEC}s`,
      secret,
    },
  )
}

export async function verifyEmailLoginToken(
  token: string,
  env: Env,
): Promise<EmailLoginToken | null> {
  const payload = await verifyHs256(token, {
    issuer: EMAIL_LOGIN_ISSUER,
    audience: EMAIL_LOGIN_AUDIENCE,
    secret: secretFor(env, 'EMAIL_LOGIN_SECRET'),
  })
  const email = payload?.email as string | undefined
  if (!email) return null
  return {
    email,
    sub: (payload?.sub as string | undefined) ?? undefined,
    givenName: (payload?.given_name as string | undefined) ?? undefined,
    familyName: (payload?.family_name as string | undefined) ?? undefined,
    issuedAt: typeof payload?.iat === 'number' ? payload.iat : undefined,
  }
}

// Build the auto-login URL for an email CTA: the /api/auth/email-login route
// carrying the signed token plus where to land afterwards. `path` is an
// app-relative path ("/setup"); the route re-validates it with safeReturnTo, so
// a tampered `to` can only ever point at another page on our own origin.
//
// Soft-fails to the plain URL. Every caller is mid-send on an email whose
// membership is already provisioned — a missing SESSION_SECRET should cost the
// recipient one sign-in step, not the entire email.
export async function emailLoginUrl(
  baseUrl: string,
  path: string,
  claim: EmailLoginToken,
  env: Env,
): Promise<string> {
  const plain = `${baseUrl}${path}`
  if (!claim.email) return plain
  try {
    const token = await signEmailLoginToken(claim, env)
    const params = new URLSearchParams({ lt: token, to: path })
    return `${baseUrl}/api/auth/email-login?${params.toString()}`
  } catch (err) {
    console.error('[email-login] could not sign auto-login link:', err)
    return plain
  }
}
