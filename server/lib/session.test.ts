// Unit tests for the session helpers. Auth0 RS256 verification is not
// exercised here (would require a fake JWKS) — getSessionEmail's Auth0 path
// is covered indirectly through checkout-session.test.ts. These tests focus
// on the HS256 checkout-token round-trip and the Bearer/cookie precedence.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import {
  getSessionEmail,
  signCheckoutToken,
  verifyCheckoutToken,
} from './session'

const ENV = { CHECKOUT_SESSION_SECRET: 'unit-test-secret-32-chars-long_____' }

function makeReq(opts: {
  authorization?: string
  cookie?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.authorization) headers.authorization = opts.authorization
  if (opts.cookie) headers.cookie = opts.cookie
  return { headers } as unknown as IncomingMessage
}

describe('signCheckoutToken / verifyCheckoutToken', () => {
  test('round-trips the email', async () => {
    const token = await signCheckoutToken('a@x.com', ENV)
    expect(await verifyCheckoutToken(token, ENV)).toBe('a@x.com')
  })

  test('rejects when secret differs', async () => {
    const token = await signCheckoutToken('a@x.com', ENV)
    const other = { CHECKOUT_SESSION_SECRET: 'different-secret-32-chars-long____' }
    expect(await verifyCheckoutToken(token, other)).toBeNull()
  })

  test('rejects malformed token', async () => {
    expect(await verifyCheckoutToken('not-a-jwt', ENV)).toBeNull()
  })

  test('returns null when secret env is absent', async () => {
    expect(await verifyCheckoutToken('x', {})).toBeNull()
  })

  test('signCheckoutToken throws without secret', async () => {
    await expect(signCheckoutToken('a@x.com', {})).rejects.toThrow(
      'CHECKOUT_SESSION_SECRET not configured',
    )
  })
})

describe('getSessionEmail', () => {
  test('uses Bearer checkout token when present', async () => {
    const token = await signCheckoutToken('bearer@x.com', ENV)
    const req = makeReq({ authorization: `Bearer ${token}` })
    expect(await getSessionEmail(req, ENV)).toBe('bearer@x.com')
  })

  test('falls back to cookie when Bearer absent', async () => {
    const token = await signCheckoutToken('cookie@x.com', ENV)
    const req = makeReq({ cookie: `ark_checkout=${token}` })
    expect(await getSessionEmail(req, ENV)).toBe('cookie@x.com')
  })

  test('returns null when neither Bearer nor cookie is present', async () => {
    expect(await getSessionEmail(makeReq({}), ENV)).toBeNull()
  })

  test('returns null when Bearer token is malformed and no cookie set', async () => {
    const req = makeReq({ authorization: 'Bearer garbage' })
    expect(await getSessionEmail(req, ENV)).toBeNull()
  })

  test('falls back to cookie when Bearer token fails verification', async () => {
    const token = await signCheckoutToken('cookie@x.com', ENV)
    const req = makeReq({
      authorization: 'Bearer garbage',
      cookie: `ark_checkout=${token}`,
    })
    expect(await getSessionEmail(req, ENV)).toBe('cookie@x.com')
  })
})
