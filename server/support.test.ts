// Routes and validation for the help-widget session log.
//
// Modelled on server/contact.test.ts — the other public unauthenticated POST.
// Note every test rebuilds the route set: the rate limiter is created per
// factory call, so sharing one across tests leaks bucket state between them.

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { makeFakeReq, makeFakeRes, neonMockModule } from './test-utils'
import type { Deps } from './lib/route'
import { validateSupportSession } from './lib/support'
import { SUPPORT_MAX_STEPS, SUPPORT_MAX_VALUE_LENGTH } from '../shared/support'

type SqlCall = { sql: string; values: unknown[] }
const calls: SqlCall[] = []
mock.module('@neondatabase/serverless', () => neonMockModule(calls, () => []))

const { supportRoutes } = await import('./routes/support')

const ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://x',
  APP_BASE_URL: 'http://localhost:5173',
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

  test('rate limits a client that floods the endpoint', async () => {
    const handler = logHandler()
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
