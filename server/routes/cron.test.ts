// Auth tests for the entitlement-reconcile cron. The reconcile itself needs
// Stripe + Auth0 + Circle and is covered elsewhere; here we pin the gate that
// keeps the endpoint from being publicly invokable. With `stripe: null` the
// handler bails with a 500 immediately *after* the auth check passes, so a
// valid secret is observable as that 500 without any network.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cronRoutes } from './cron'
import type { Deps, Handler } from '../lib/route.js'

const PATH = '/api/cron/reconcile-entitlements'
const SECRET = 'cron-secret-value'

function deps(env: Record<string, string>): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: 'http://localhost:5173',
    activator: {} as Deps['activator'],
  }
}

function route(env: Record<string, string>): Handler {
  const handler = cronRoutes(deps(env)).find((r) => r.path === PATH)?.handler
  if (!handler) throw new Error(`route ${PATH} not found`)
  return handler
}

function makeReq(opts: { method?: string; auth?: string }): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.auth !== undefined) headers.authorization = opts.auth
  return { method: opts.method ?? 'POST', url: PATH, headers } as unknown as IncomingMessage
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(chunk?: string) {
      if (chunk) res.body += chunk
    },
  }
  return res as typeof res & ServerResponse
}

async function call(env: Record<string, string>, req: IncomingMessage) {
  const res = makeRes()
  await route(env)(req, res)
  return res
}

describe('GET/POST /api/cron/reconcile-entitlements (auth gate)', () => {
  test('405s on a disallowed method', async () => {
    const res = await call({ CRON_SECRET: SECRET }, makeReq({ method: 'PUT', auth: `Bearer ${SECRET}` }))
    expect(res.statusCode).toBe(405)
  })

  test('500s (not open) when CRON_SECRET is unset', async () => {
    const res = await call({}, makeReq({ auth: `Bearer whatever` }))
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toBe('CRON_SECRET missing')
  })

  test('401s when the Authorization header is missing', async () => {
    const res = await call({ CRON_SECRET: SECRET }, makeReq({}))
    expect(res.statusCode).toBe(401)
  })

  test('401s on a wrong secret of equal length', async () => {
    const wrong = 'x'.repeat(`Bearer ${SECRET}`.length - 'Bearer '.length)
    const res = await call({ CRON_SECRET: SECRET }, makeReq({ auth: `Bearer ${wrong}` }))
    expect(res.statusCode).toBe(401)
  })

  test('401s on a secret that is a prefix (length mismatch)', async () => {
    const res = await call({ CRON_SECRET: SECRET }, makeReq({ auth: `Bearer ${SECRET.slice(0, -1)}` }))
    expect(res.statusCode).toBe(401)
  })

  test('passes auth with the correct secret (then 500s on missing Stripe) — GET and POST', async () => {
    for (const method of ['GET', 'POST']) {
      const res = await call({ CRON_SECRET: SECRET }, makeReq({ method, auth: `Bearer ${SECRET}` }))
      // Reaching the Stripe check proves the constant-time compare accepted the
      // secret; a failed auth would have returned 401 first.
      expect(res.statusCode).toBe(500)
      expect(JSON.parse(res.body).error).toBe('STRIPE_SECRET_KEY missing')
    }
  })
})
