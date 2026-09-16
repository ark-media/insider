// Cookie helpers for the app's two server-set sessions.
//
//   ark_session — the long-term login session (Approach B / BFF). Set by
//     /api/auth/callback after the server-side OAuth exchange; an httpOnly
//     HS256 JWT carrying { email, roles, name }. The companion
//     `ark_session_present` is JS-readable so the SPA can detect the session
//     without exposing the token.
//   ark_checkout — the short-lived post-checkout auto-login session, so a
//     brand-new subscriber reaches /setup before their password-reset email
//     arrives. Same httpOnly + companion-present shape.
//   ark_auth_txn — a 10-minute httpOnly cookie holding the in-flight OAuth
//     transaction (PKCE verifier, state, nonce, returnTo) between /login and
//     /callback.

import type { IncomingMessage, ServerResponse } from 'node:http'

type Env = Record<string, string>

export const CHECKOUT_TOKEN_TTL_SEC = 30 * 60
export const CHECKOUT_COOKIE_NAME = 'ark_checkout'
export const CHECKOUT_PRESENT_COOKIE_NAME = 'ark_checkout_present'

export const SESSION_TOKEN_TTL_SEC = 7 * 24 * 60 * 60
export const SESSION_COOKIE_NAME = 'ark_session'
export const SESSION_PRESENT_COOKIE_NAME = 'ark_session_present'

export const AUTH_TXN_TTL_SEC = 10 * 60
export const AUTH_TXN_COOKIE_NAME = 'ark_auth_txn'

export function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim()
    }
  }
  return null
}

function buildCookie(
  name: string,
  value: string,
  opts: { maxAgeSec: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' },
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    `SameSite=${opts.sameSite}`,
    `Max-Age=${opts.maxAgeSec}`,
  ]
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

function isSecureOrigin(env: Env): boolean {
  return env.APP_BASE_URL?.startsWith('https://') ?? false
}

// Strict everywhere except local dev. Strict is safe for the app's normal
// reads (the SPA fetches /api/me same-origin, which Strict still sends) and
// for the prod OAuth return (auth.ark-plus.xyz and the app share the
// ark-plus.xyz registrable domain → same-site). Local dev runs on localhost,
// which is cross-site to the Auth0 domain, so the callback would lose the
// cookie under Strict — fall back to Lax there.
function isLocal(env: Env): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.APP_BASE_URL ?? '')
}

function sameSite(env: Env): 'Strict' | 'Lax' {
  return isLocal(env) ? 'Lax' : 'Strict'
}

// Append to any existing Set-Cookie header rather than overwrite, so two
// helpers can run on the same response (e.g. logout clears both the session
// and checkout cookies in one pass).
function appendSetCookie(res: ServerResponse, cookies: string[]): void {
  const existing = res.getHeader('Set-Cookie')
  const prior = Array.isArray(existing)
    ? existing
    : existing !== undefined
      ? [String(existing)]
      : []
  res.setHeader('Set-Cookie', [...prior, ...cookies])
}

function setPair(
  res: ServerResponse,
  tokenName: string,
  presentName: string,
  token: string,
  ttlSec: number,
  env: Env,
): void {
  const secure = isSecureOrigin(env)
  const ss = sameSite(env)
  appendSetCookie(res, [
    buildCookie(tokenName, token, { maxAgeSec: ttlSec, httpOnly: true, secure, sameSite: ss }),
    buildCookie(presentName, '1', { maxAgeSec: ttlSec, httpOnly: false, secure, sameSite: ss }),
  ])
}

function clearPair(
  res: ServerResponse,
  tokenName: string,
  presentName: string,
  env: Env,
): void {
  const secure = isSecureOrigin(env)
  const ss = sameSite(env)
  appendSetCookie(res, [
    buildCookie(tokenName, '', { maxAgeSec: 0, httpOnly: true, secure, sameSite: ss }),
    buildCookie(presentName, '', { maxAgeSec: 0, httpOnly: false, secure, sameSite: ss }),
  ])
}

export function setCheckoutCookies(res: ServerResponse, token: string, env: Env): void {
  setPair(res, CHECKOUT_COOKIE_NAME, CHECKOUT_PRESENT_COOKIE_NAME, token, CHECKOUT_TOKEN_TTL_SEC, env)
}

export function clearCheckoutCookies(res: ServerResponse, env: Env): void {
  clearPair(res, CHECKOUT_COOKIE_NAME, CHECKOUT_PRESENT_COOKIE_NAME, env)
}

export function setSessionCookies(res: ServerResponse, token: string, env: Env): void {
  setPair(res, SESSION_COOKIE_NAME, SESSION_PRESENT_COOKIE_NAME, token, SESSION_TOKEN_TTL_SEC, env)
}

export function clearSessionCookies(res: ServerResponse, env: Env): void {
  clearPair(res, SESSION_COOKIE_NAME, SESSION_PRESENT_COOKIE_NAME, env)
}

// The in-flight OAuth transaction cookie — single httpOnly value, no
// JS-readable companion (the SPA never needs to see it).
//
// Always Lax, never Strict. The callback can arrive via a *cross-site*
// redirect chain: a social login bounces ark-plus.xyz → auth.ark-plus.xyz →
// accounts.google.com → auth.ark-plus.xyz → /api/auth/callback. Chrome judges
// same-site across the whole chain, so the third-party hop (Google) makes the
// final navigation cross-site and a Strict cookie would be withheld — the
// callback would see no txn and bounce the user to ?auth_error=expired even
// though sign-in succeeded. Lax is sent on top-level GET navigations through a
// cross-site redirect, which is exactly what an OAuth state/PKCE cookie needs.
export function setAuthTxnCookie(res: ServerResponse, token: string, env: Env): void {
  appendSetCookie(res, [
    buildCookie(AUTH_TXN_COOKIE_NAME, token, {
      maxAgeSec: AUTH_TXN_TTL_SEC,
      httpOnly: true,
      secure: isSecureOrigin(env),
      sameSite: 'Lax',
    }),
  ])
}

export function clearAuthTxnCookie(res: ServerResponse, env: Env): void {
  appendSetCookie(res, [
    buildCookie(AUTH_TXN_COOKIE_NAME, '', {
      maxAgeSec: 0,
      httpOnly: true,
      secure: isSecureOrigin(env),
      sameSite: sameSite(env),
    }),
  ])
}
