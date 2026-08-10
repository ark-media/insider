// Unit tests for the session helpers. Auth0 RS256 verification is not
// exercised here (would require a fake JWKS) — getSessionEmail's Auth0 path
// is covered indirectly through checkout-session.test.ts. These tests focus
// on the HS256 checkout-token round-trip and the Bearer/cookie precedence.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import {
  extractStrings,
  getSessionEmail,
  getSessionProfile,
  requireAdmin,
  sessionName,
  signAuthTxnToken,
  signCheckoutToken,
  signSessionToken,
  verifyAuthTxnToken,
  verifyCheckoutToken,
  verifySessionToken,
  type AuthTxn,
} from './session'
import { SESSION_COOKIE_NAME } from './cookies'

const ENV = { CHECKOUT_SESSION_SECRET: 'unit-test-secret-32-chars-long_____' }
const SENV = {
  CHECKOUT_SESSION_SECRET: 'unit-test-secret-32-chars-long_____',
  SESSION_SECRET: 'session-secret-32-chars-long-aaaaaa',
}

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

  test('resolves the ark_session cookie', async () => {
    const token = await signSessionToken({ email: 's@x.com', roles: [] }, SENV)
    const req = makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` })
    expect(await getSessionEmail(req, SENV)).toBe('s@x.com')
  })
})

describe('session token', () => {
  test('round-trips email, roles, name parts, sub', async () => {
    const profile = {
      email: 'a@x.com',
      roles: ['admin'],
      givenName: 'Ada',
      familyName: 'Lovelace',
      sub: 'auth0|abc',
    }
    const token = await signSessionToken(profile, SENV)
    expect(await verifySessionToken(token, SENV)).toEqual(profile)
  })

  test('defaults roles to [] and omits absent name/sub', async () => {
    const token = await signSessionToken({ email: 'b@x.com', roles: [] }, SENV)
    expect(await verifySessionToken(token, SENV)).toEqual({
      email: 'b@x.com',
      roles: [],
      givenName: undefined,
      familyName: undefined,
      sub: undefined,
    })
  })

  test('the display name is derived from its parts, never stored separately', async () => {
    const token = await signSessionToken(
      { email: 'a@x.com', roles: [], givenName: 'Ada', familyName: 'Lovelace' },
      SENV,
    )
    const session = await verifySessionToken(token, SENV)
    expect(sessionName(session!)).toBe('Ada Lovelace')
    // A name manufactured from the email resolves to nothing, so callers that
    // pass it on (Auth0 create, gift activation) don't propagate the junk.
    const junk = await signSessionToken(
      { email: 'ada.l9@x.com', roles: [], givenName: 'ada.l9' },
      SENV,
    )
    expect(sessionName((await verifySessionToken(junk, SENV))!)).toBeUndefined()
  })

  test('rejects a wrong secret and a checkout token (audience mismatch)', async () => {
    const token = await signSessionToken({ email: 'b@x.com', roles: [] }, SENV)
    expect(await verifySessionToken(token, { SESSION_SECRET: 'other-secret-32-chars-long-bbbbbbb' })).toBeNull()
    const checkout = await signCheckoutToken('b@x.com', SENV)
    expect(await verifySessionToken(checkout, SENV)).toBeNull()
  })

  test('signSessionToken throws without secret', async () => {
    await expect(signSessionToken({ email: 'b@x.com', roles: [] }, {})).rejects.toThrow(
      'SESSION_SECRET not configured',
    )
  })

  test('getSessionProfile reads roles/sub from the cookie', async () => {
    const token = await signSessionToken(
      { email: 'a@x.com', roles: ['admin'], sub: 'auth0|abc' },
      SENV,
    )
    const req = makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const profile = await getSessionProfile(req, SENV)
    expect(profile?.roles).toEqual(['admin'])
    expect(profile?.sub).toBe('auth0|abc')
  })
})

describe('auth txn token', () => {
  const txn: AuthTxn = { verifier: 'v', state: 's', nonce: 'n', returnTo: '/account' }

  test('round-trips the transaction', async () => {
    const token = await signAuthTxnToken(txn, SENV)
    expect(await verifyAuthTxnToken(token, SENV)).toEqual(txn)
  })

  test('rejects a session token (audience mismatch)', async () => {
    const session = await signSessionToken({ email: 'a@x.com', roles: [] }, SENV)
    expect(await verifyAuthTxnToken(session, SENV)).toBeNull()
  })
})

describe('requireAdmin', () => {
  test('passes for a session cookie carrying the admin role', async () => {
    const token = await signSessionToken({ email: 'a@x.com', roles: ['admin'] }, SENV)
    const req = makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const admin = await requireAdmin(req, SENV)
    expect(admin?.email).toBe('a@x.com')
  })

  test('rejects a session cookie without the admin role', async () => {
    const token = await signSessionToken({ email: 'a@x.com', roles: ['member'] }, SENV)
    const req = makeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` })
    expect(await requireAdmin(req, SENV)).toBeNull()
  })

  test('rejects when there is no session', async () => {
    expect(await requireAdmin(makeReq({}), SENV)).toBeNull()
  })
})

describe('extractStrings', () => {
  test('keeps a string array, wraps a lone string, else []', () => {
    expect(extractStrings(['a', 1, 'b'])).toEqual(['a', 'b'])
    expect(extractStrings('admin')).toEqual(['admin'])
    expect(extractStrings(undefined)).toEqual([])
    expect(extractStrings('')).toEqual([])
  })
})
