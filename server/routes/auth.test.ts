// Unit tests for the BFF auth routes' no-network branches. The full OAuth
// exchange (login → Auth0 → callback) needs live discovery and is covered by
// the end-to-end check; here we pin the branches that bail before any network:
// not-configured, missing transaction, logout, signout.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authRoutes, loginConnection, safeReturnTo } from './auth'
import type { Deps, Handler } from '../lib/route.js'
import { AUTH_TXN_COOKIE_NAME, SESSION_COOKIE_NAME } from '../lib/cookies'
import {
  emailLoginUrl,
  signAuthTxnToken,
  signEmailLoginToken,
  signSessionToken,
  verifyEmailLoginToken,
  verifySessionToken,
} from '../lib/session'

const APP = 'http://localhost:5173'

function deps(env: Record<string, string>): Deps {
  return {
    env: { APP_BASE_URL: APP, ...env },
    stripe: null,
    appBaseUrl: APP,
    activator: {} as Deps['activator'],
  }
}

function route(env: Record<string, string>, path: string): Handler {
  const handler = authRoutes(deps(env)).find((r) => r.path === path)?.handler
  if (!handler) throw new Error(`route ${path} not found`)
  return handler
}

function makeReq(opts: {
  method?: string
  url?: string
  cookie?: string
  headers?: Record<string, string>
}): IncomingMessage {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.cookie) headers.cookie = opts.cookie
  return { method: opts.method ?? 'GET', url: opts.url ?? '/', headers } as unknown as IncomingMessage
}

function makeRes() {
  const headers: Record<string, string | string[]> = {}
  const res = {
    statusCode: 200,
    body: '',
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()]
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk
    },
  }
  return res as typeof res & ServerResponse
}

const CONFIGURED = {
  AUTH0_WEB_CLIENT_ID: 'web-client',
  AUTH0_WEB_CLIENT_SECRET: 'web-secret',
  SESSION_SECRET: 'session-secret-32-chars-long-aaaaaa',
}

describe('GET /api/auth/login', () => {
  test('500s when the confidential client is not configured', async () => {
    const res = makeRes()
    await route({}, '/api/auth/login')(makeReq({ url: '/api/auth/login' }), res)
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toBe('auth_not_configured')
  })
})

describe('loginConnection', () => {
  test('honors the connections we actually offer', () => {
    expect(loginConnection('email')).toBe('email')
    expect(loginConnection('google-oauth2')).toBe('google-oauth2')
    expect(loginConnection('Username-Password-Authentication')).toBe(
      'Username-Password-Authentication',
    )
  })

  test('drops anything else rather than forwarding it to Auth0', () => {
    // A connection we haven't vetted — enabled in the tenant or not, a crafted
    // link must not be able to choose which credential Auth0 accepts.
    expect(loginConnection('sms')).toBeNull()
    expect(loginConnection('some-enterprise-conn')).toBeNull()
    // Auth0 connection names are case-sensitive; near-misses aren't honored.
    expect(loginConnection('Email')).toBeNull()
    expect(loginConnection('')).toBeNull()
    expect(loginConnection(null)).toBeNull()
    expect(loginConnection(undefined)).toBeNull()
  })
})

describe('GET /api/auth/callback', () => {
  test('redirects to an error when the transaction cookie is missing', async () => {
    const res = makeRes()
    await route(CONFIGURED, '/api/auth/callback')(
      makeReq({ url: '/api/auth/callback?code=x&state=y' }),
      res,
    )
    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe('/?auth_error=expired')
    // And it clears the (here, absent) txn cookie defensively.
    const setCookie = res.getHeader('Set-Cookie') as string[]
    expect(setCookie.some((c) => c.startsWith(`${AUTH_TXN_COOKIE_NAME}=`))).toBe(true)
  })

  test('access_denied from Auth0 maps to the "denied" message, not "exchange"', async () => {
    const env = { ...CONFIGURED, APP_BASE_URL: APP }
    const txn = await signAuthTxnToken(
      { verifier: 'v', state: 's', nonce: 'n', returnTo: '/' },
      env,
    )
    const res = makeRes()
    await route(env, '/api/auth/callback')(
      makeReq({
        url: '/api/auth/callback?error=access_denied&error_description=not+provisioned',
        cookie: `${AUTH_TXN_COOKIE_NAME}=${txn}`,
      }),
      res,
    )
    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe('/?auth_error=denied')
  })

  test('a non-access_denied OAuth error still falls back to "exchange"', async () => {
    const env = { ...CONFIGURED, APP_BASE_URL: APP }
    const txn = await signAuthTxnToken(
      { verifier: 'v', state: 's', nonce: 'n', returnTo: '/' },
      env,
    )
    const res = makeRes()
    await route(env, '/api/auth/callback')(
      makeReq({
        url: '/api/auth/callback?error=server_error',
        cookie: `${AUTH_TXN_COOKIE_NAME}=${txn}`,
      }),
      res,
    )
    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe('/?auth_error=exchange')
  })
})

describe('GET /api/auth/logout', () => {
  test('clears session + checkout cookies and redirects to Auth0 logout', async () => {
    const res = makeRes()
    await route(CONFIGURED, '/api/auth/logout')(makeReq({ url: '/api/auth/logout' }), res)
    expect(res.statusCode).toBe(302)
    const loc = res.getHeader('Location') as string
    expect(loc).toContain('/v2/logout')
    expect(loc).toContain('client_id=web-client')
    expect(loc).toContain(encodeURIComponent(APP))
    const setCookie = res.getHeader('Set-Cookie') as string[]
    expect(setCookie.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0'))).toBe(true)
  })

  test('falls back to the app origin when no client id is set', async () => {
    const res = makeRes()
    await route({}, '/api/auth/logout')(makeReq({ url: '/api/auth/logout' }), res)
    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe(APP)
  })

  test('ignores a cross-site forced logout without clearing cookies', async () => {
    const res = makeRes()
    await route(CONFIGURED, '/api/auth/logout')(
      makeReq({ url: '/api/auth/logout', headers: { 'sec-fetch-site': 'cross-site' } }),
      res,
    )
    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe(APP)
    // No cookies cleared — the forced logout is a no-op.
    expect(res.getHeader('Set-Cookie')).toBeUndefined()
  })

  test('ignores a sub-resource logout (non-document dest) without clearing cookies', async () => {
    const res = makeRes()
    await route(CONFIGURED, '/api/auth/logout')(
      makeReq({ url: '/api/auth/logout', headers: { 'sec-fetch-dest': 'image' } }),
      res,
    )
    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe(APP)
    // An attacker's <img src=.../logout> must not trigger the cookie-clear.
    expect(res.getHeader('Set-Cookie')).toBeUndefined()
  })

  test('allows a same-origin top-level navigation (document dest)', async () => {
    const res = makeRes()
    await route(CONFIGURED, '/api/auth/logout')(
      makeReq({
        url: '/api/auth/logout',
        headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' },
      }),
      res,
    )
    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Set-Cookie')).toBeDefined()
  })
})

describe('safeReturnTo', () => {
  test('keeps a same-origin absolute path (with query + hash)', () => {
    expect(safeReturnTo('/account', APP)).toBe('/account')
    expect(safeReturnTo('/account?tab=billing#x', APP)).toBe('/account?tab=billing#x')
    expect(safeReturnTo(`${APP}/setup`, APP)).toBe('/setup')
  })

  test('falls back to "/" for empty/missing input', () => {
    expect(safeReturnTo(null, APP)).toBe('/')
    expect(safeReturnTo(undefined, APP)).toBe('/')
    expect(safeReturnTo('', APP)).toBe('/')
  })

  test('rejects cross-origin and scheme-changing redirects', () => {
    expect(safeReturnTo('//evil.com', APP)).toBe('/')
    expect(safeReturnTo('/\\evil.com', APP)).toBe('/')
    expect(safeReturnTo('https://evil.com/path', APP)).toBe('/')
    expect(safeReturnTo('http://evil.com', APP)).toBe('/')
    expect(safeReturnTo('javascript:alert(1)', APP)).toBe('/')
  })

  // These parse to OUR origin but normalize to a pathname beginning with "//",
  // which a browser re-reads as protocol-relative once it lands in a Location
  // header. An origin check alone lets every one of them through.
  test('rejects paths that normalize to protocol-relative', () => {
    expect(safeReturnTo('/..//evil.com', APP)).toBe('/')
    expect(safeReturnTo('/../..//evil.com', APP)).toBe('/')
    expect(safeReturnTo(`//${new URL(APP).host}//evil.com`, APP)).toBe('/')
    expect(safeReturnTo(`${APP}//evil.com`, APP)).toBe('/')
    expect(safeReturnTo(`//${new URL(APP).host}/\\/evil.com`, APP)).toBe('/')
    expect(safeReturnTo('/\t/evil.com', APP)).toBe('/')
  })

  test('still preserves legitimate paths that contain traversal or encoding', () => {
    expect(safeReturnTo('/a/../b', APP)).toBe('/b')
    expect(safeReturnTo('/%2F/evil.com', APP)).toBe('/%2F/evil.com')
    expect(safeReturnTo('/redeem?mt=abc#top', APP)).toBe('/redeem?mt=abc#top')
  })
})

describe('POST /api/signout', () => {
  test('clears both sessions and 200s', async () => {
    const res = makeRes()
    await route({}, '/api/signout')(makeReq({ method: 'POST', url: '/api/signout' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    const setCookie = res.getHeader('Set-Cookie') as string[]
    expect(setCookie).toHaveLength(4)
  })

  test('405s on GET', async () => {
    const res = makeRes()
    await route({}, '/api/signout')(makeReq({ method: 'GET', url: '/api/signout' }), res)
    expect(res.statusCode).toBe(405)
  })
})

// --- GET /api/auth/email-login -------------------------------------------
//
// The auto-login link every lifecycle email now carries. These pin the three
// branches that matter: a good token mints a session and forwards, a bad one
// degrades to the normal login rather than an error, and an existing session
// for the same person is left alone (re-minting would strip a real login back
// down to the bare email the reminder crons know).

describe('GET /api/auth/email-login', () => {
  const PATH = '/api/auth/email-login'

  async function link(claim: Parameters<typeof signEmailLoginToken>[0]) {
    return signEmailLoginToken(claim, CONFIGURED)
  }

  function setCookies(res: ReturnType<typeof makeRes>): string[] {
    const raw = res.getHeader('Set-Cookie')
    return Array.isArray(raw) ? raw : raw ? [String(raw)] : []
  }

  test('a valid token mints a session and forwards to the destination', async () => {
    const lt = await link({ email: 'member@example.com', sub: 'auth0|abc' })
    const res = makeRes()
    await route(CONFIGURED, PATH)(
      makeReq({ url: `${PATH}?lt=${encodeURIComponent(lt)}&to=%2Fsetup` }),
      res,
    )

    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe('/setup')
    // The token must not survive into the address bar.
    expect(String(res.getHeader('Location'))).not.toContain('lt=')

    const cookies = setCookies(res)
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true)
    // The JS-readable companion is what tells the SPA to call /api/me at all —
    // without it the page renders as a guest despite the session cookie.
    expect(cookies.some((c) => c.startsWith('ark_session_present='))).toBe(true)
  })

  test('the minted session carries the email, sub and name from the token', async () => {
    const lt = await link({
      email: 'member@example.com',
      sub: 'auth0|abc',
      givenName: 'Ada',
      familyName: 'Lovelace',
    })
    const res = makeRes()
    await route(CONFIGURED, PATH)(
      makeReq({ url: `${PATH}?lt=${encodeURIComponent(lt)}&to=%2Fsetup` }),
      res,
    )

    const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!
    const token = cookie.slice(`${SESSION_COOKIE_NAME}=`.length).split(';')[0]!
    const profile = await verifySessionToken(token, CONFIGURED)
    expect(profile?.email).toBe('member@example.com')
    expect(profile?.sub).toBe('auth0|abc')
    expect(profile?.givenName).toBe('Ada')
    // An emailed link never confers admin, whoever clicks it.
    expect(profile?.roles).toEqual([])
    // ...and the session is marked as link-minted. The link is replayable for
    // two weeks and rides in a GET URL, so what it buys can read the account
    // and set up feeds but not touch billing (requireLoginAssurance).
    expect(profile?.via).toBe('email_link')
  })

  test('a missing or forged token falls through to the normal login, keeping the destination', async () => {
    for (const query of ['', '?to=%2Fsetup', '?lt=not-a-jwt&to=%2Fsetup']) {
      const res = makeRes()
      await route(CONFIGURED, PATH)(makeReq({ url: PATH + query }), res)
      expect(res.statusCode).toBe(302)
      const location = String(res.getHeader('Location'))
      expect(location).toStartWith('/api/auth/login?returnTo=')
      expect(setCookies(res)).toEqual([])
    }
    // The destination survives the fallback, so an expired link still lands the
    // member where they were going — just behind a sign-in.
    const res = makeRes()
    await route(CONFIGURED, PATH)(makeReq({ url: `${PATH}?to=%2Fsetup` }), res)
    expect(res.getHeader('Location')).toBe(
      `/api/auth/login?returnTo=${encodeURIComponent('/setup')}`,
    )
  })

  test('a token signed with another secret is rejected', async () => {
    const lt = await signEmailLoginToken(
      { email: 'member@example.com' },
      { SESSION_SECRET: 'a-different-secret-32-chars-long-aa' },
    )
    const res = makeRes()
    await route(CONFIGURED, PATH)(
      makeReq({ url: `${PATH}?lt=${encodeURIComponent(lt)}&to=%2Fsetup` }),
      res,
    )
    expect(String(res.getHeader('Location'))).toStartWith('/api/auth/login?')
    expect(setCookies(res)).toEqual([])
  })

  test('an off-origin destination is refused, not emitted as a redirect', async () => {
    const lt = await link({ email: 'member@example.com' })
    const res = makeRes()
    await route(CONFIGURED, PATH)(
      makeReq({ url: `${PATH}?lt=${encodeURIComponent(lt)}&to=https%3A%2F%2Fevil.com` }),
      res,
    )
    expect(res.getHeader('Location')).toBe('/')
  })

  test('an existing session for the same member is kept, not re-minted', async () => {
    // The reminder crons know only an email, so re-minting here would drop the
    // sub and name a real login had put in the cookie.
    const existing = await signSessionToken(
      {
        email: 'member@example.com',
        roles: [],
        sub: 'auth0|abc',
        givenName: 'Ada',
      },
      CONFIGURED,
    )
    const lt = await link({ email: 'MEMBER@example.com' })
    const res = makeRes()
    await route(CONFIGURED, PATH)(
      makeReq({
        url: `${PATH}?lt=${encodeURIComponent(lt)}&to=%2Fsetup`,
        cookie: `${SESSION_COOKIE_NAME}=${existing}`,
      }),
      res,
    )

    expect(res.statusCode).toBe(302)
    expect(res.getHeader('Location')).toBe('/setup')
    expect(setCookies(res)).toEqual([])
  })

  test('a link addressed to someone else re-mints — the addressee wins', async () => {
    const existing = await signSessionToken(
      { email: 'first@example.com', roles: [], sub: 'auth0|first' },
      CONFIGURED,
    )
    const lt = await link({ email: 'second@example.com', sub: 'auth0|second' })
    const res = makeRes()
    await route(CONFIGURED, PATH)(
      makeReq({
        url: `${PATH}?lt=${encodeURIComponent(lt)}&to=%2Fsetup`,
        cookie: `${SESSION_COOKIE_NAME}=${existing}`,
      }),
      res,
    )

    const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!
    const token = cookie.slice(`${SESSION_COOKIE_NAME}=`.length).split(';')[0]!
    expect((await verifySessionToken(token, CONFIGURED))?.email).toBe(
      'second@example.com',
    )
  })
})

describe('emailLoginUrl', () => {
  test('wraps the destination in a verifiable auto-login link', async () => {
    const url = await emailLoginUrl(
      APP,
      '/setup',
      { email: 'member@example.com', sub: 'auth0|abc' },
      CONFIGURED,
    )
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/auth/email-login')
    expect(parsed.searchParams.get('to')).toBe('/setup')

    const claim = await verifyEmailLoginToken(parsed.searchParams.get('lt')!, CONFIGURED)
    expect(claim?.email).toBe('member@example.com')
    expect(claim?.sub).toBe('auth0|abc')
  })

  test('soft-fails to the plain URL when no secret is configured', async () => {
    // The membership is already provisioned by the time any of this runs — a
    // missing secret should cost one sign-in step, not the whole email.
    expect(await emailLoginUrl(APP, '/setup', { email: 'm@example.com' }, {})).toBe(
      `${APP}/setup`,
    )
  })
})
