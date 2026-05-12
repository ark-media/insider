// Cookie helpers for the post-checkout session.
//
// The auto-login flow ships an httpOnly JWT in `ark_checkout` plus a
// non-httpOnly companion (`ark_checkout_present`) so the SPA can detect
// session presence without exposing the token to JS.

import type { IncomingMessage, ServerResponse } from 'node:http'

type Env = Record<string, string>

export const CHECKOUT_TOKEN_TTL_SEC = 30 * 60
export const CHECKOUT_COOKIE_NAME = 'ark_checkout'
export const CHECKOUT_PRESENT_COOKIE_NAME = 'ark_checkout_present'

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
  opts: { maxAgeSec: number; httpOnly: boolean; secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSec}`,
  ]
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

function isSecureOrigin(env: Env): boolean {
  return env.APP_BASE_URL?.startsWith('https://') ?? false
}

export function setCheckoutCookies(
  res: ServerResponse,
  token: string,
  env: Env,
): void {
  const secure = isSecureOrigin(env)
  res.setHeader('Set-Cookie', [
    buildCookie(CHECKOUT_COOKIE_NAME, token, {
      maxAgeSec: CHECKOUT_TOKEN_TTL_SEC,
      httpOnly: true,
      secure,
    }),
    buildCookie(CHECKOUT_PRESENT_COOKIE_NAME, '1', {
      maxAgeSec: CHECKOUT_TOKEN_TTL_SEC,
      httpOnly: false,
      secure,
    }),
  ])
}

export function clearCheckoutCookies(res: ServerResponse, env: Env): void {
  const secure = isSecureOrigin(env)
  res.setHeader('Set-Cookie', [
    buildCookie(CHECKOUT_COOKIE_NAME, '', { maxAgeSec: 0, httpOnly: true, secure }),
    buildCookie(CHECKOUT_PRESENT_COOKIE_NAME, '', { maxAgeSec: 0, httpOnly: false, secure }),
  ])
}
