// The Circle SSO login gate (server/routes/circle-gate.ts) — the endpoint the
// Auth0 post-login action asks before letting anyone into thefold.arkmedia.org.
//
// Two things are pinned here, and they fail in opposite directions:
//   * the auth gate, because an open endpoint would let anyone enumerate who
//     holds a community membership;
//   * the allow/deny/error split, because the action turns "deny" into an
//     upsell page and "error" into a retry. Answering `allow: false` on a
//     lookup failure would march a paying member to a sales page, so a Neon
//     outage must surface as a 500 and never as a verdict.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import {
  makeFakeReq,
  makeFakeRes,
  neonMockModule,
  silenceExpectedConsole,
  type SqlCall,
} from './test-utils'

const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown = () => []
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql) => nextSqlResult(sql)),
)

// Import AFTER mock.module so getDb picks up the fake driver.
import { circleGateRoutes } from './routes/circle-gate'
import type { Deps, Handler } from './lib/route'

silenceExpectedConsole()

const PATH = '/api/internal/circle-access'
const SECRET = 'gate-secret-value'
const ENV = { CIRCLE_GATE_SECRET: SECRET, DATABASE_URL: 'postgres://stub-circle-gate' }

function route(env: Record<string, string>): Handler {
  const handler = circleGateRoutes({
    env,
    stripe: null,
    appBaseUrl: 'http://localhost:5173',
    activator: {} as Deps['activator'],
  } as Deps).find((r) => r.path === PATH)?.handler
  if (!handler) throw new Error(`route ${PATH} not found`)
  return handler
}

async function call(
  env: Record<string, string>,
  opts: { method?: string; bearer?: string; body?: unknown } = {},
) {
  const res = makeFakeRes()
  const req: IncomingMessage = makeFakeReq({
    method: opts.method ?? 'POST',
    url: PATH,
    bearer: opts.bearer,
    body: opts.body,
  })
  await route(env)(req, res)
  return res
}

// A membership row shaped like getMembershipByAuth0Sub's projection.
const row = (over: Record<string, unknown> = {}) => ({
  auth0_sub: 'auth0|123',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  sc_user_id: 42,
  tier: 'ark-plus',
  status: 'active',
  plan: 'monthly',
  amount_cents: 800,
  current_period_end: null,
  cancel_at: null,
  ark_plus_gift_expires_at: null,
  circle_gift_expires_at: null,
  ...over,
})

function stageMembership(rows: unknown[]) {
  nextSqlResult = (sql) => (sql.includes('from membership') ? rows : [])
}

const DAY_MS = 24 * 60 * 60 * 1000
const future = () => new Date(Date.now() + 30 * DAY_MS).toISOString()
const past = () => new Date(Date.now() - DAY_MS).toISOString()

beforeEach(() => {
  sqlCalls.length = 0
  stageMembership([])
})

describe('POST /api/internal/circle-access — auth gate', () => {
  test('405s on a disallowed method', async () => {
    const res = await call(ENV, { method: 'GET', bearer: SECRET })
    expect(res.statusCode).toBe(405)
  })

  test('500s when the shared secret is unconfigured', async () => {
    const res = await call({ DATABASE_URL: ENV.DATABASE_URL }, { bearer: SECRET })
    expect(res.statusCode).toBe(500)
    expect(res.__json()).toEqual({ error: 'not_configured' })
  })

  test('401s with no credential', async () => {
    const res = await call(ENV, { body: { sub: 'auth0|123' } })
    expect(res.statusCode).toBe(401)
  })

  test('401s on a wrong secret', async () => {
    const res = await call(ENV, { bearer: 'not-the-secret', body: { sub: 'auth0|123' } })
    expect(res.statusCode).toBe(401)
  })

  test('rejects before reading the body, so an unauthorized caller never reaches Neon', async () => {
    stageMembership([row({ tier: 'bundle' })])
    const res = await call(ENV, { bearer: 'wrong', body: { sub: 'auth0|123' } })
    expect(res.statusCode).toBe(401)
    expect(sqlCalls).toHaveLength(0)
  })

  test('500s when Neon is unconfigured rather than answering "not entitled"', async () => {
    const res = await call({ CIRCLE_GATE_SECRET: SECRET }, { bearer: SECRET, body: { sub: 'auth0|1' } })
    expect(res.statusCode).toBe(500)
    expect(res.__json()).toEqual({ error: 'not_configured' })
  })

  test('400s without a sub', async () => {
    expect((await call(ENV, { bearer: SECRET })).statusCode).toBe(400)
    expect((await call(ENV, { bearer: SECRET, body: {} })).statusCode).toBe(400)
    expect((await call(ENV, { bearer: SECRET, body: { sub: '   ' } })).statusCode).toBe(400)
    expect((await call(ENV, { bearer: SECRET, body: { sub: 42 } })).statusCode).toBe(400)
  })

  test('never lets the answer be cached', async () => {
    stageMembership([row({ tier: 'bundle' })])
    const res = await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })
    expect(res.__headers()['cache-control']).toBe('private, no-store')
  })
})

describe('POST /api/internal/circle-access — verdicts', () => {
  test('allows a Circle member', async () => {
    stageMembership([row({ tier: 'circle' })])
    const res = await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ allow: true, tier: 'circle' })
  })

  test('allows a Bundle member', async () => {
    stageMembership([row({ tier: 'bundle' })])
    expect((await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })).__json()).toEqual({
      allow: true,
      tier: 'bundle',
    })
  })

  // The whole point of the gate: podcasts bought, community not.
  test('refuses an Ark+-only member', async () => {
    stageMembership([row({ tier: 'ark-plus' })])
    expect((await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })).__json()).toEqual({
      allow: false,
      tier: 'ark-plus',
    })
  })

  test('refuses someone with no membership row', async () => {
    stageMembership([])
    expect((await call(ENV, { bearer: SECRET, body: { sub: 'auth0|nobody' } })).__json()).toEqual({
      allow: false,
      tier: 'free',
    })
  })

  test('refuses a torn-down (cancelled) membership', async () => {
    // subscription.deleted removes the row; a stale one with no live axis must
    // not grant anything either.
    stageMembership([row({ tier: 'circle', stripe_subscription_id: null, circle_gift_expires_at: past() })])
    expect((await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })).__json()).toEqual({
      allow: false,
      tier: 'free',
    })
  })

  test('allows a live Community gift with no subscription behind it', async () => {
    stageMembership([
      row({ tier: 'circle', stripe_subscription_id: null, circle_gift_expires_at: future() }),
    ])
    expect((await call(ENV, { bearer: SECRET, body: { sub: 'auth0|gift' } })).__json()).toEqual({
      allow: true,
      tier: 'circle',
    })
  })

  // An Ark+ subscriber holding a live Community gift resolves to bundle (D4) —
  // the gate must read the union of the axes, not the row's `tier` column.
  test('allows an Ark+ subscriber holding a live Community gift', async () => {
    stageMembership([row({ tier: 'ark-plus', circle_gift_expires_at: future() })])
    expect((await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })).__json()).toEqual({
      allow: true,
      tier: 'bundle',
    })
  })

  test('refuses an Ark+ subscriber whose Community gift has run out', async () => {
    stageMembership([row({ tier: 'ark-plus', circle_gift_expires_at: past() })])
    expect((await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })).__json()).toEqual({
      allow: false,
      tier: 'ark-plus',
    })
  })

  test('keys the lookup on the posted sub', async () => {
    stageMembership([row({ tier: 'bundle' })])
    await call(ENV, { bearer: SECRET, body: { sub: 'auth0|abc' } })
    const lookup = sqlCalls.find((c) => c.sql.includes('from membership'))
    expect(lookup?.values).toContain('auth0|abc')
  })

  test('a Neon failure is a 500, never a verdict', async () => {
    nextSqlResult = () => {
      throw new Error('neon is down')
    }
    const res = await call(ENV, { bearer: SECRET, body: { sub: 'auth0|123' } })
    expect(res.statusCode).toBe(500)
    expect(res.__json()).toEqual({ error: 'lookup_failed' })
  })
})
