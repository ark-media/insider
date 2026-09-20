// logAdminAction — the back-office audit trail.
//
// What's pinned here is mostly what it must NOT do: throw into a request whose
// mutation already succeeded, depend on its table existing (a deploy that ran
// ahead of its migration has taken this site down before), or carry a query
// string / control characters into the trail. The route-level wiring — that each
// admin mutation actually calls it — is in server/admin-audit-routes.test.ts.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { makeFakeReq, neonMockModule, type SqlCall } from '../test-utils'

const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

const { logAdminAction } = await import('./admin-audit')

const ENV = { DATABASE_URL: 'postgres://stub-admin-audit' }
const ADMIN = { email: 'ava@ark.example', sub: 'auth0|admin-1' }

const originalLog = console.log
const originalError = console.error
let logged: string[] = []
let errors: string[] = []

beforeEach(() => {
  sqlCalls.length = 0
  nextSqlResult = () => []
  logged = []
  errors = []
  console.log = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '))
})

afterEach(() => {
  console.log = originalLog
  console.error = originalError
})

function auditInserts(): SqlCall[] {
  return sqlCalls.filter((c) => c.sql.includes('insert into admin_audit_log'))
}

function consoleEntry(): Record<string, unknown> {
  const line = logged.find((l) => l.startsWith('[admin-audit] '))
  if (!line) throw new Error('no [admin-audit] console line')
  return JSON.parse(line.slice('[admin-audit] '.length)) as Record<string, unknown>
}

describe('logAdminAction', () => {
  test('inserts one row carrying who, what and where', async () => {
    const req = makeFakeReq({ method: 'DELETE', url: '/api/admin/promos?id=co_123' })
    await logAdminAction(ENV, ADMIN, req, {
      action: 'promo.delete',
      targetId: 'co_123',
      summary: 'name=SPRING 15% off duration=once',
    })

    const inserts = auditInserts()
    expect(inserts).toHaveLength(1)
    expect(inserts[0].values).toEqual([
      'auth0|admin-1',
      'ava@ark.example',
      'DELETE',
      '/api/admin/promos',
      'promo.delete',
      'co_123',
      'name=SPRING 15% off duration=once',
    ])
    expect(errors).toHaveLength(0)
  })

  test('always emits the structured console line, with the same fields', async () => {
    const req = makeFakeReq({ method: 'POST', url: '/api/admin/faqs' })
    await logAdminAction(ENV, ADMIN, req, { action: 'faq.create', targetId: 'f-1' })

    expect(consoleEntry()).toMatchObject({
      admin_sub: 'auth0|admin-1',
      admin_email: 'ava@ark.example',
      method: 'POST',
      path: '/api/admin/faqs',
      action: 'faq.create',
      target_id: 'f-1',
      summary: null,
    })
    expect(typeof consoleEntry().at).toBe('string')
  })

  // The member directory's search carries the looked-up email in the query.
  test('records the pathname only, never the query string', async () => {
    const req = makeFakeReq({ url: '/api/admin/members?email=jane%40example.com' })
    await logAdminAction(ENV, ADMIN, req, { action: 'members.search' })

    expect(auditInserts()[0].values[3]).toBe('/api/admin/members')
    expect(logged.join('\n')).not.toContain('jane')
  })

  test('without DATABASE_URL it logs to the console and touches no database', async () => {
    const req = makeFakeReq({ method: 'PUT', url: '/api/admin/feed-reminders' })
    await logAdminAction({}, ADMIN, req, { action: 'feed_reminders.update' })

    expect(sqlCalls).toHaveLength(0)
    expect(consoleEntry().action).toBe('feed_reminders.update')
    expect(errors).toHaveLength(0)
  })

  // Code deployed before migration 0005 ran. The mutation already happened; the
  // audit write must not be what fails the request.
  test('tolerates the table not existing yet', async () => {
    nextSqlResult = () => {
      throw Object.assign(new Error('relation "admin_audit_log" does not exist'), {
        code: '42P01',
      })
    }
    const req = makeFakeReq({ method: 'POST', url: '/api/admin/careers' })

    await expect(
      logAdminAction(ENV, ADMIN, req, { action: 'career.create' }),
    ).resolves.toBeUndefined()

    expect(consoleEntry().action).toBe('career.create')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('[admin-audit]')
    expect(errors[0]).toContain('0005_admin_audit_log')
  })

  test('swallows any other insert failure into one greppable line', async () => {
    nextSqlResult = () => {
      throw new Error('connection terminated')
    }
    const req = makeFakeReq({ method: 'POST', url: '/api/admin/careers' })

    await expect(
      logAdminAction(ENV, ADMIN, req, { action: 'career.create' }),
    ).resolves.toBeUndefined()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('[admin-audit] insert failed')
    expect(errors[0]).toContain('connection terminated')
  })

  test('a session with no sub still logs, with a null admin_sub', async () => {
    const req = makeFakeReq({ method: 'POST', url: '/api/admin/faqs' })
    await logAdminAction(ENV, { email: 'ava@ark.example' }, req, { action: 'faq.create' })
    expect(auditInserts()[0].values[0]).toBeNull()
  })

  // A summary is built from admin-typed text (a coupon name, a slug). It must
  // not be able to forge a second log line, or grow without bound.
  test('flattens control characters and caps the summary', async () => {
    const req = makeFakeReq({ method: 'POST', url: '/api/admin/promos' })
    await logAdminAction(ENV, ADMIN, req, {
      action: 'promo.create',
      summary: `name=x\r\n[admin-audit] {"forged":true}\t${'y'.repeat(1000)}`,
    })

    const summary = String(auditInserts()[0].values[6])
    expect(summary).not.toMatch(/[\r\n\t]/)
    expect(summary.length).toBeLessThanOrEqual(300)
    expect(logged.filter((l) => l.startsWith('[admin-audit]'))).toHaveLength(1)
  })
})
