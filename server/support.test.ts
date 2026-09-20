// Routes and validation for the help-widget session log.
//
// Modelled on server/contact.test.ts — the other public unauthenticated POST.
// Note every test rebuilds the route set: the rate limiter is created per
// factory call, so sharing one across tests leaks bucket state between them.

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { makeFakeReq, makeFakeRes, neonMockModule } from './test-utils'
import type { Deps } from './lib/route'
import { recordSupportSession, validateSupportSession } from './lib/support'
import { getDb } from './lib/db'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'
import { SUPPORT_MAX_STEPS, SUPPORT_MAX_VALUE_LENGTH } from '../shared/support'

type SqlCall = { sql: string; values: unknown[] }
const calls: SqlCall[] = []
mock.module('@neondatabase/serverless', () => neonMockModule(calls, () => []))

const { supportRoutes } = await import('./routes/support')

const ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://x',
  APP_BASE_URL: 'http://localhost:5173',
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
}

function makeDeps(env: Record<string, string> = ENV): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:5173',
    activator: {} as Deps['activator'],
  }
}

function logHandler(env = ENV) {
  return supportRoutes(makeDeps(env)).find((r) => r.path === '/api/support/log')!.handler
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'abcd1234efgh',
    steps: [{ at: '2026-09-08T10:00:00.000Z', kind: 'query', value: 'how do I cancel' }],
    ...overrides,
  }
}

async function post(handler: ReturnType<typeof logHandler>, body: unknown, headers = {}) {
  const req = makeFakeReq({
    method: 'POST',
    url: '/api/support/log',
    body: JSON.stringify(body),
    headers: { origin: 'http://localhost:5173', ...headers },
  })
  const res = makeFakeRes()
  await handler(req, res)
  return res
}

beforeEach(() => { calls.length = 0 })

describe('POST /api/support/log', () => {
  test('records a valid session', async () => {
    const res = await post(logHandler(), validBody())
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
    expect(calls.some((c) => c.sql.includes('insert into support_conversations'))).toBe(true)
  })

  test('rejects a cross-origin post', async () => {
    const res = await post(logHandler(), validBody(), { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test('rejects a malformed session id', async () => {
    const res = await post(logHandler(), validBody({ sessionId: 'short' }))
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'invalid_session_id' })
  })

  test('rejects a payload with no usable steps', async () => {
    const res = await post(logHandler(), validBody({ steps: [{ kind: 'nonsense', value: 'x' }] }))
    expect(res.statusCode).toBe(400)
  })

  test('rejects more steps than a session can legitimately have', async () => {
    const steps = Array.from({ length: SUPPORT_MAX_STEPS + 1 }, () => ({
      at: '2026-09-08T10:00:00.000Z', kind: 'query', value: 'x',
    }))
    const res = await post(logHandler(), validBody({ steps }))
    expect(res.statusCode).toBe(400)
    expect(res.__json()).toEqual({ error: 'too_many_steps' })
  })

  // Without DATABASE_URL the shared limiter is its in-memory fallback — same
  // shape and limits, and the limit is checked before anything needs a database.
  // (With one, the fake driver here answers every query with no rows, which the
  // limiter reads as "allowed"; its Neon path is shared-rate-limit's to test.)
  test('rate limits a client that floods the endpoint', async () => {
    const handler = logHandler({ APP_BASE_URL: ENV.APP_BASE_URL })
    let last = await post(handler, validBody())
    for (let i = 0; i < 40 && last.statusCode === 200; i += 1) {
      last = await post(handler, validBody())
    }
    expect(last.statusCode).toBe(429)
    expect(last.__headers()['retry-after']).toBeDefined()
  })

  // Logging is a side benefit of the widget, never a dependency: an unconfigured
  // or broken database must not surface as an error the widget has to handle.
  test('succeeds without a database rather than failing the widget', async () => {
    const res = await post(logHandler({ APP_BASE_URL: ENV.APP_BASE_URL }), validBody())
    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(0)
  })
})

// The session id is client-chosen and is the row's only key. Once a row belongs
// to a member, only that member may rewrite it; everyone else's write is a no-op
// the caller can't distinguish from one that landed.
//
// The rule itself is enforced inside the upsert (atomically — a read-then-write
// in the route would race), and there is no Postgres in this suite, so these pin
// the two halves it depends on: the guard is in the statement, and the email it
// compares against is the server-derived identity and nothing else.
describe('support log — a session attributed to a member', () => {
  function upsert() {
    const call = calls.find((c) => c.sql.includes('insert into support_conversations'))
    if (!call) throw new Error('no support_conversations upsert recorded')
    return call
  }
  // Interpolation order in recordSupportSession: session_id, email, steps, escalated.
  const emailOf = (c: SqlCall) => c.values[1]

  async function memberCookie(email: string): Promise<string> {
    const token = await signSessionToken({ email, roles: [] }, ENV)
    return `${SESSION_COOKIE_NAME}=${token}`
  }

  test('the upsert only updates a row that is unattributed or already this identity\'s', async () => {
    const parsed = validateSupportSession(validBody())
    if (!parsed.ok) throw new Error('fixture should validate')
    await recordSupportSession(getDb(ENV), parsed.value, 'jane@example.com')
    const sql = upsert().sql.replace(/\s+/g, ' ')
    expect(sql).toContain(
      'where support_conversations.email is null or lower(support_conversations.email) = lower(excluded.email)',
    )
    // The guard belongs to the conflict arm: it must come after `do update set`.
    expect(sql.indexOf('do update set')).toBeLessThan(sql.indexOf('where support_conversations.email'))
  })

  test('an anonymous post carries a null email, which the guard can never match', async () => {
    const res = await post(logHandler(), validBody())
    expect(emailOf(upsert())).toBeNull()
    // …and is answered exactly like a write that landed.
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
  })

  test('a signed-in post carries the session\'s email', async () => {
    const res = await post(logHandler(), validBody(), {
      cookie: await memberCookie('jane@example.com'),
    })
    expect(res.statusCode).toBe(200)
    expect(emailOf(upsert())).toBe('jane@example.com')
  })

  test('an email in the request body is never the identity', async () => {
    const res = await post(logHandler(), validBody({ email: 'jane@example.com' }))
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
    expect(emailOf(upsert())).toBeNull()
    expect(JSON.stringify(upsert().values)).not.toContain('jane@example.com')
  })

  test('a different signed-in member presents their own email, not the row owner\'s', async () => {
    await post(logHandler(), validBody({ email: 'jane@example.com' }), {
      cookie: await memberCookie('mallory@example.com'),
    })
    expect(emailOf(upsert())).toBe('mallory@example.com')
  })
})

describe('validateSupportSession', () => {
  test('drops unknown step kinds but keeps the valid ones', () => {
    const r = validateSupportSession({
      sessionId: 'abcd1234efgh',
      steps: [
        { at: '2026-09-08T10:00:00.000Z', kind: 'query', value: 'a' },
        { at: '2026-09-08T10:00:01.000Z', kind: 'exfiltrate', value: 'b' },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.steps.map((s) => s.kind)).toEqual(['query'])
  })

  test('truncates an over-long value rather than rejecting the session', () => {
    const r = validateSupportSession({
      sessionId: 'abcd1234efgh',
      steps: [{ at: '2026-09-08T10:00:00.000Z', kind: 'query', value: 'x'.repeat(5000) }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.steps[0].value).toHaveLength(SUPPORT_MAX_VALUE_LENGTH)
  })

  test('replaces an unparseable timestamp instead of storing it', () => {
    const r = validateSupportSession({
      sessionId: 'abcd1234efgh',
      steps: [{ at: 'not-a-date', kind: 'query', value: 'a' }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Number.isNaN(Date.parse(r.value.steps[0].at))).toBe(false)
  })
})
