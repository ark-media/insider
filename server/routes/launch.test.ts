// Tests for the launch-mode routes. Wires `launchRoutes()` with a minimal Deps
// bundle and exercises the handlers with fake req/res.
//
// Scoped to behaviors that don't need real infrastructure: the public route's
// method/cache/no-DB contract and the admin route's auth gate. The DB-backed
// get/set paths need a live Neon connection and a verifiable Auth0 admin token,
// so they're out of scope here — matching how faqs/announcements split unit
// tests from integration.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { launchRoutes } from './launch.js'
import type { Deps } from '../lib/route.js'

const PUBLIC_PATH = '/api/launch-mode'
const ADMIN_PATH = '/api/admin/launch-mode'

type FakeRes = ServerResponse & {
  __json: () => unknown
  __header: (name: string) => string | undefined
  __status: () => number
}

function makeReq(
  method: string,
  path: string,
  opts: { headers?: Record<string, string> } = {},
): IncomingMessage {
  return {
    method,
    url: path,
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
  const route = launchRoutes(deps).find((r) => r.path === path)
  if (!route) throw new Error(`route ${path} not registered`)
  return route.handler
}

describe('GET /api/launch-mode — public contract', () => {
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
    expect(res.__header('cache-control')).toContain('s-maxage=30')
    expect(res.__header('cache-control')).toContain('stale-while-revalidate=60')
  })

  test('falls back to soft when DATABASE_URL is unset', async () => {
    const handler = findHandler(buildDeps(), PUBLIC_PATH)
    const res = makeRes()
    await handler(makeReq('GET', PUBLIC_PATH), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ mode: 'soft' })
  })
})

describe('/api/admin/launch-mode — admin gate', () => {
  // No Bearer token / session → requireAdminRequest returns null before any
  // DB work, so every method is forbidden regardless of DATABASE_URL.
  for (const method of ['GET', 'PUT']) {
    test(`${method} without a bearer token is 403`, async () => {
      const handler = findHandler(
        buildDeps({ DATABASE_URL: 'postgres://unused' }),
        ADMIN_PATH,
      )
      const res = makeRes()
      await handler(makeReq(method, ADMIN_PATH), res)
      expect(res.__status()).toBe(403)
      expect(res.__json()).toEqual({ error: 'forbidden' })
    })
  }
})
