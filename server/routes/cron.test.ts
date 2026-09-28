// Auth tests for the entitlement-reconcile cron. The reconcile itself needs
// Stripe + Auth0 + Circle and is covered elsewhere; here we pin the gate that
// keeps the endpoint from being publicly invokable. With `stripe: null` the
// handler bails with a 500 immediately *after* the auth check passes, so a
// valid secret is observable as that 500 without any network.

import { describe, test, expect, mock, afterAll, spyOn } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { neonMockModule, type SqlCall } from '../test-utils'

// Neon mock, for the renewal-reminders run below (the auth-gate tests never
// reach the DB). Routes by query text via `nextSqlResult`.
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

import { cronRoutes } from './cron'
import * as auth0User from '../lib/auth0-user.js'
import type { Deps, Handler } from '../lib/route.js'

const PATH = '/api/cron/reconcile-entitlements'
const PRUNE_PATH = '/api/cron/prune-webhook-events'
const SECRET = 'cron-secret-value'

function deps(env: Record<string, string>): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: 'http://localhost:5173',
    activator: {} as Deps['activator'],
  }
}

function route(env: Record<string, string>, path = PATH): Handler {
  const handler = cronRoutes(deps(env)).find((r) => r.path === path)?.handler
  if (!handler) throw new Error(`route ${path} not found`)
  return handler
}

function makeReq(opts: { method?: string; auth?: string; url?: string }): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.auth !== undefined) headers.authorization = opts.auth
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? PATH,
    headers,
  } as unknown as IncomingMessage
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

async function call(env: Record<string, string>, req: IncomingMessage, path = PATH) {
  const res = makeRes()
  await route(env, path)(req, res)
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
    expect(JSON.parse(res.body).error).toBe('not_configured')
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
      expect(JSON.parse(res.body).error).toBe('not_configured')
    }
  })
})

describe('per-axis reconcile paths (auth gate)', () => {
  // vercel.json schedules these, one invocation per axis.
  for (const path of [`${PATH}/ark-plus`, `${PATH}/circle`]) {
    test(`${path}: 401s without the secret, passes with it`, async () => {
      const denied = await call({ CRON_SECRET: SECRET }, makeReq({ url: path }), path)
      expect(denied.statusCode).toBe(401)
      const res = await call(
        { CRON_SECRET: SECRET },
        makeReq({ auth: `Bearer ${SECRET}`, url: path }),
        path,
      )
      // Reaching the Stripe check proves auth passed.
      expect(res.statusCode).toBe(500)
      expect(JSON.parse(res.body).error).toBe('not_configured')
    })
  }
})

describe('GET/POST /api/cron/prune-webhook-events (auth gate)', () => {
  const req = (opts: { method?: string; auth?: string }) =>
    makeReq({ ...opts, url: PRUNE_PATH })

  test('405s on a disallowed method', async () => {
    const res = await call({ CRON_SECRET: SECRET }, req({ method: 'PUT', auth: `Bearer ${SECRET}` }), PRUNE_PATH)
    expect(res.statusCode).toBe(405)
  })

  test('500s (not open) when CRON_SECRET is unset', async () => {
    const res = await call({}, req({ auth: `Bearer whatever` }), PRUNE_PATH)
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toBe('not_configured')
  })

  test('401s when the Authorization header is missing', async () => {
    const res = await call({ CRON_SECRET: SECRET }, req({}), PRUNE_PATH)
    expect(res.statusCode).toBe(401)
  })

  test('401s on a wrong secret of equal length', async () => {
    const wrong = 'x'.repeat(`Bearer ${SECRET}`.length - 'Bearer '.length)
    const res = await call({ CRON_SECRET: SECRET }, req({ auth: `Bearer ${wrong}` }), PRUNE_PATH)
    expect(res.statusCode).toBe(401)
  })

  test('passes auth with the correct secret (then 500s on missing DATABASE_URL) — GET and POST', async () => {
    for (const method of ['GET', 'POST']) {
      // Reaching the DATABASE_URL check proves the constant-time compare
      // accepted the secret; a failed auth would have returned 401 first.
      const res = await call({ CRON_SECRET: SECRET }, req({ method, auth: `Bearer ${SECRET}` }), PRUNE_PATH)
      expect(res.statusCode).toBe(500)
      expect(JSON.parse(res.body).error).toBe('not_configured')
    }
  })
})

// R6 — the renewal-reminder cron wires Stripe's renewal-invoice preview into the
// email: the amount the member reads is `invoice.amount_due` in the invoice's
// currency. The recipient lookup is spied (other files mock the Auth0 SDK
// process-wide, so an HTTP-level Auth0 stub isn't reliable in a full run),
// Resend is answered by a stubbed global fetch, Neon by the module mock above.
describe('/api/cron/renewal-reminders — R6 quoted amount', () => {
  const RENEW_PATH = '/api/cron/renewal-reminders'
  const PERIOD_END = '2030-01-01T00:00:00.000Z'
  const realFetch = globalThis.fetch
  const resendBodies: { to: string; subject: string; html: string }[] = []
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  test('R6: the email carries the amount from stripe.invoices.createPreview (amount_due + currency)', async () => {
    const profileSpy = spyOn(auth0User, 'getAuth0NameProfile').mockResolvedValue({
      email: 'annual@example.com',
      givenName: 'Dana',
      familyName: null,
      setByMember: false,
    } as Awaited<ReturnType<typeof auth0User.getAuth0NameProfile>>)
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.resend.com')) {
        resendBodies.push(JSON.parse(String(init?.body)))
        return new Response('{"id":"email_1"}', { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    nextSqlResult = (sql) =>
      sql.includes('from membership')
        ? [
            {
              auth0_sub: 'auth0|annual',
              stripe_subscription_id: 'sub_annual',
              tier: 'ark-plus',
              scheduled_tier: null,
              pending_plan: null,
              current_period_end: PERIOD_END,
            },
          ]
        : []

    const previews: unknown[] = []
    const stripe = {
      invoices: {
        createPreview: async (params: unknown) => {
          previews.push(params)
          // Discounted + taxed renewal: deliberately not the list price.
          return { amount_due: 6150, currency: 'gbp' }
        },
      },
    }
    const env = {
      CRON_SECRET: SECRET,
      DATABASE_URL: 'postgres://stub-cron-renewal',
      RESEND_API_KEY: 'rk_test',
      AUTH0_TENANT_DOMAIN: 'https://tenant.test.auth0.com',
      AUTH0_MANAGEMENT_CLIENT_ID: 'mgmt-client-cron-test',
      AUTH0_MANAGEMENT_CLIENT_SECRET: 'mgmt-secret',
    }
    const handler = cronRoutes({ ...deps(env), stripe: stripe as never }).find(
      (r) => r.path === RENEW_PATH,
    )?.handler
    if (!handler) throw new Error('renewal route not found')
    const res = makeRes()
    await handler(makeReq({ auth: `Bearer ${SECRET}`, url: RENEW_PATH }), res)

    expect(res.statusCode).toBe(200)
    expect(previews).toEqual([{ subscription: 'sub_annual' }])
    expect(JSON.parse(res.body)).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 0 })
    expect(resendBodies).toHaveLength(1)
    expect(resendBodies[0].to).toBe('annual@example.com')
    expect(resendBodies[0].html).toContain('£61.50')
    expect(profileSpy).toHaveBeenCalledWith(expect.anything(), 'auth0|annual')
    profileSpy.mockRestore()
  })
})
