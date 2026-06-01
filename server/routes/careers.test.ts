// Tests for the careers routes. Wires `careerRoutes()` with a minimal Deps
// bundle and exercises the handlers with fake req/res.
//
// Coverage here is deliberately scoped to behaviors that don't need real
// infrastructure: the public route's method/shape contract (including the
// no-DB degradation), and the admin route's auth gate. The DB-backed paths
// (list/create/409-on-dup-slug/404-on-disabled-slug) need a live Neon
// connection and a verifiable Auth0 admin token — both exercised against the
// real DB, not here — so they're out of scope for this unit test, matching how
// announcements/promos split lib unit tests from integration.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { careerRoutes } from './careers.js'
import type { Deps } from '../lib/route.js'

const PUBLIC_PATH = '/api/careers'
const ADMIN_PATH = '/api/admin/careers'

// --- Fake req/res ----------------------------------------------------------
type FakeRes = ServerResponse & {
  __json: () => unknown
  __header: (name: string) => string | undefined
  __status: () => number
}

function makeReq(
  method: string,
  path: string,
  opts: { query?: string; headers?: Record<string, string> } = {},
): IncomingMessage {
  const url = opts.query ? `${path}?${opts.query}` : path
  return {
    method,
    url,
    headers: opts.headers ?? {},
  } as unknown as IncomingMessage
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {}
  let body = ''
  let statusCode = 200
  let ended = false
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    get headersSent() {
      return ended
    },
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value)
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()]
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === 'string' ? chunk : chunk.toString()
      ended = true
    },
    __json: () => JSON.parse(body) as unknown,
    __header: (name: string) => headers[name.toLowerCase()],
    __status: () => statusCode,
  } as unknown as FakeRes
  return res
}

function buildDeps(env: Record<string, string> = {}): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: 'http://localhost:5173',
    activator: {} as Deps['activator'],
  }
}

function findHandler(deps: Deps, path: string) {
  const route = careerRoutes(deps).find((r) => r.path === path)
  if (!route) throw new Error(`route ${path} not registered`)
  return route.handler
}

// --- Public route ----------------------------------------------------------

describe('GET /api/careers — public contract', () => {
  test('rejects non-GET with 405', async () => {
    const handler = findHandler(buildDeps(), PUBLIC_PATH)
    const res = makeRes()
    await handler(makeReq('POST', PUBLIC_PATH), res)
    expect(res.__status()).toBe(405)
  })

  test('sets an SWR cache-control header', async () => {
    const handler = findHandler(buildDeps(), PUBLIC_PATH)
    const res = makeRes()
    await handler(makeReq('GET', PUBLIC_PATH), res)
    expect(res.__header('cache-control')).toContain('s-maxage=60')
    expect(res.__header('cache-control')).toContain('stale-while-revalidate=300')
  })

  test('list returns an empty array when DATABASE_URL is unset', async () => {
    const handler = findHandler(buildDeps(), PUBLIC_PATH)
    const res = makeRes()
    await handler(makeReq('GET', PUBLIC_PATH), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ careers: [] })
  })

  test('slug lookup returns 404 when DATABASE_URL is unset (shape matches request)', async () => {
    const handler = findHandler(buildDeps(), PUBLIC_PATH)
    const res = makeRes()
    await handler(makeReq('GET', PUBLIC_PATH, { query: 'slug=history-host' }), res)
    expect(res.__status()).toBe(404)
    expect(res.__json()).toEqual({ error: 'not_found' })
  })
})

// --- Admin route auth gate -------------------------------------------------

describe('/api/admin/careers — admin gate', () => {
  // No Bearer token → requireAdmin returns null before any DB/JWKS work, so
  // every method is forbidden regardless of DATABASE_URL.
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    test(`${method} without a bearer token is 403`, async () => {
      const handler = findHandler(buildDeps({ DATABASE_URL: 'postgres://unused' }), ADMIN_PATH)
      const res = makeRes()
      await handler(makeReq(method, ADMIN_PATH, { query: 'id=abc' }), res)
      expect(res.__status()).toBe(403)
      expect(res.__json()).toEqual({ error: 'forbidden' })
    })
  }

  test('a non-Bearer Authorization header is still forbidden', async () => {
    const handler = findHandler(buildDeps({ DATABASE_URL: 'postgres://unused' }), ADMIN_PATH)
    const res = makeRes()
    await handler(
      makeReq('GET', ADMIN_PATH, { headers: { authorization: 'Basic abc' } }),
      res,
    )
    expect(res.__status()).toBe(403)
  })
})
