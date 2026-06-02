import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AUTH_TXN_COOKIE_NAME,
  CHECKOUT_COOKIE_NAME,
  CHECKOUT_PRESENT_COOKIE_NAME,
  CHECKOUT_TOKEN_TTL_SEC,
  SESSION_COOKIE_NAME,
  SESSION_PRESENT_COOKIE_NAME,
  SESSION_TOKEN_TTL_SEC,
  clearAuthTxnCookie,
  clearCheckoutCookies,
  clearSessionCookies,
  readCookie,
  setAuthTxnCookie,
  setCheckoutCookies,
  setSessionCookies,
} from './cookies'

const PROD = { APP_BASE_URL: 'https://example.com' }
const LOCAL = { APP_BASE_URL: 'http://localhost:5173' }

function makeReq(cookie?: string): IncomingMessage {
  return { headers: cookie ? { cookie } : {} } as unknown as IncomingMessage
}

function makeRes() {
  const headers: Record<string, string | string[]> = {}
  return {
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()]
    },
  } as unknown as ServerResponse
}

describe('readCookie', () => {
  test('parses single cookie', () => {
    expect(readCookie(makeReq('ark_checkout=abc'), 'ark_checkout')).toBe('abc')
  })

  test('parses one cookie from a multi-value header', () => {
    const req = makeReq('foo=1; ark_checkout=xyz; bar=baz')
    expect(readCookie(req, 'ark_checkout')).toBe('xyz')
  })

  test('returns null when cookie header is absent', () => {
    expect(readCookie(makeReq(), 'ark_checkout')).toBeNull()
  })

  test('returns null when key is missing', () => {
    expect(readCookie(makeReq('foo=1'), 'ark_checkout')).toBeNull()
  })

  test('trims surrounding whitespace', () => {
    expect(readCookie(makeReq('  ark_checkout = abc '), 'ark_checkout')).toBe('abc')
  })

  test('does not partial-match cookie name', () => {
    expect(readCookie(makeReq('ark_checkout_present=1'), 'ark_checkout')).toBeNull()
  })
})

describe('setCheckoutCookies', () => {
  test('emits both cookies with HttpOnly on token and not on present', () => {
    const res = makeRes()
    setCheckoutCookies(res, 'jwt-value', { APP_BASE_URL: 'https://example.com' })
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies).toHaveLength(2)
    const token = cookies.find((c) => c.startsWith(`${CHECKOUT_COOKIE_NAME}=`))!
    const present = cookies.find((c) =>
      c.startsWith(`${CHECKOUT_PRESENT_COOKIE_NAME}=`),
    )!
    expect(token).toContain('jwt-value')
    expect(token).toContain('HttpOnly')
    expect(token).toContain('Secure')
    expect(token).toContain(`Max-Age=${CHECKOUT_TOKEN_TTL_SEC}`)
    expect(token).toContain('SameSite=Strict')
    expect(present).toContain('=1')
    expect(present).not.toContain('HttpOnly')
    expect(present).toContain('Secure')
  })

  test('omits Secure when APP_BASE_URL is http', () => {
    const res = makeRes()
    setCheckoutCookies(res, 'jwt', { APP_BASE_URL: 'http://localhost:5173' })
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies.every((c) => !c.includes('Secure'))).toBe(true)
  })
})

describe('clearCheckoutCookies', () => {
  test('emits zero-Max-Age cookies for both names', () => {
    const res = makeRes()
    clearCheckoutCookies(res, { APP_BASE_URL: 'https://example.com' })
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies).toHaveLength(2)
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.find((c) => c.startsWith(`${CHECKOUT_COOKIE_NAME}=`))).toContain(
      'HttpOnly',
    )
  })
})

describe('setSessionCookies', () => {
  test('emits httpOnly token + JS-readable present, with session TTL', () => {
    const res = makeRes()
    setSessionCookies(res, 'sess-jwt', PROD)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    const token = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!
    const present = cookies.find((c) => c.startsWith(`${SESSION_PRESENT_COOKIE_NAME}=`))!
    expect(token).toContain('sess-jwt')
    expect(token).toContain('HttpOnly')
    expect(token).toContain(`Max-Age=${SESSION_TOKEN_TTL_SEC}`)
    expect(present).toContain('=1')
    expect(present).not.toContain('HttpOnly')
  })
})

describe('clearSessionCookies', () => {
  test('zeroes both session cookies', () => {
    const res = makeRes()
    clearSessionCookies(res, PROD)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies).toHaveLength(2)
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })
})

describe('auth txn cookie', () => {
  test('single httpOnly cookie, no present companion; Strict off localhost', () => {
    const res = makeRes()
    setAuthTxnCookie(res, 'txn-jwt', PROD)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toContain(`${AUTH_TXN_COOKIE_NAME}=txn-jwt`)
    expect(cookies[0]).toContain('HttpOnly')
    expect(cookies[0]).toContain('SameSite=Strict')
  })

  test('Lax on localhost (cross-site to the Auth0 domain)', () => {
    const res = makeRes()
    setAuthTxnCookie(res, 'txn-jwt', LOCAL)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies[0]).toContain('SameSite=Lax')
  })

  test('clear zeroes it', () => {
    const res = makeRes()
    clearAuthTxnCookie(res, PROD)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies[0]).toContain('Max-Age=0')
  })
})

describe('SameSite policy', () => {
  test('Strict off localhost', () => {
    const res = makeRes()
    setSessionCookies(res, 'x', PROD)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies.every((c) => c.includes('SameSite=Strict'))).toBe(true)
  })

  test('Lax on localhost', () => {
    const res = makeRes()
    setSessionCookies(res, 'x', LOCAL)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies.every((c) => c.includes('SameSite=Lax'))).toBe(true)
  })
})

describe('appendSetCookie composition', () => {
  test('clearing session then checkout yields all four cookies', () => {
    const res = makeRes()
    clearSessionCookies(res, PROD)
    clearCheckoutCookies(res, PROD)
    const cookies = res.getHeader!('Set-Cookie') as string[]
    expect(cookies).toHaveLength(4)
  })
})
