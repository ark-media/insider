import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CHECKOUT_COOKIE_NAME,
  CHECKOUT_PRESENT_COOKIE_NAME,
  CHECKOUT_TOKEN_TTL_SEC,
  clearCheckoutCookies,
  readCookie,
  setCheckoutCookies,
} from './cookies'

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
    expect(token).toContain('SameSite=Lax')
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
