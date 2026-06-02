// Unit tests for the BFF auth routes' no-network branches. The full OAuth
// exchange (login → Auth0 → callback) needs live discovery and is covered by
// the end-to-end check; here we pin the branches that bail before any network:
// not-configured, missing transaction, logout, signout.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authRoutes, safeReturnTo } from './auth'
import type { Deps, Handler } from '../lib/route.js'
import { AUTH_TXN_COOKIE_NAME, SESSION_COOKIE_NAME } from '../lib/cookies'
import { signAuthTxnToken } from '../lib/session'

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
