// The back office's audit trail, at the route level: every successful admin
// mutation — and every bulk read of member data — leaves exactly one row in
// admin_audit_log naming the admin, the action and the target; a refused or
// failed one leaves none. logAdminAction's own guarantees (never throws,
// tolerates a missing table) are in server/lib/admin-audit.test.ts.
//
// Also pinned here, because they ride the same authorised-admin harness the
// other admin suites don't have: a junk `?id=` is a 400 rather than a Postgres
// cast error surfacing as a 500, and admin responses are `private, no-store`.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

type SqlCall = { sql: string; values: unknown[] }
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string, values: unknown[]) => unknown = () => []

// Not test-utils' neonMockModule: the faqs/careers accessors interpolate their
// column list with `sql.unsafe(...)` and the cancellations one calls
// `sql.query(...)`, neither of which that fake carries.
mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const merged = strings.join('?')
        sqlCalls.push({ sql: merged, values })
        return Promise.resolve(nextSqlResult(merged, values))
      },
      {
        unsafe: (s: string) => s,
        // The cancellations accessor builds its filtered query as text + params.
        query: (text: string, params: unknown[] = []) => {
          sqlCalls.push({ sql: text, values: params })
          return Promise.resolve(nextSqlResult(text, params))
        },
      },
    ),
  __esModule: true,
}))

const stripeCalls: string[] = []
class FakeStripe {
  constructor(_key: string) {}
  coupons = {
    create: async () => {
      stripeCalls.push('coupons.create')
      return { id: 'co_new', valid: true, metadata: {}, duration: 'forever', times_redeemed: 0 }
    },
    retrieve: async (id: string) => ({
      id,
      name: 'Spring sale',
      percent_off: 15,
      amount_off: null,
      currency: null,
      duration: 'repeating',
      duration_in_months: 3,
    }),
    del: async () => {
      stripeCalls.push('coupons.del')
      return { deleted: true }
    },
    list: async () => ({ data: [], has_more: false }),
  }
  promotionCodes = {
    create: async (args: { code: string }) => ({
      code: args.code,
      max_redemptions: null,
      times_redeemed: 0,
      expires_at: null,
      restrictions: { first_time_transaction: false, minimum_amount: null },
    }),
    list: async () => ({ data: [], has_more: false }),
  }
  customers = {
    list: async () => ({
      data: [{ id: 'cus_1', email: 'jane@example.com', name: 'Jane Listener' }],
    }),
  }
}
mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER mock.module so the plugin picks up both fakes.
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes,
  runMiddleware,
  silenceExpectedConsole,
  type FakeRes,
} from './test-utils'
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'
import { DEFAULT_REMINDER_CONFIG } from '../shared/feed-reminder'
import { DEFAULT_MIGRATION_CONFIG } from '../shared/feed-migration'
import { DEFAULT_OPEN_HOUSE_CONFIG } from '../shared/open-house'

const ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-admin-audit-routes',
}

const harness = createDevApiHarness(devApiPlugin(ENV))

const ADMIN_EMAIL = 'ava@ark.example'
const ADMIN_SUB = 'auth0|admin-1'
const ID = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b'
const NOW = '2026-09-01T00:00:00.000Z'

async function cookieFor(roles: string[]): Promise<string> {
  const token = await signSessionToken({ email: ADMIN_EMAIL, sub: ADMIN_SUB, roles }, ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function call(
  method: string,
  url: string,
  opts: { body?: unknown; roles?: string[]; origin?: string } = {},
): Promise<FakeRes> {
  const res = makeFakeRes()
  await runMiddleware(
    harness.getHandler(url.split('?')[0]),
    makeFakeReq({
      method,
      url,
      body: opts.body,
      cookie: await cookieFor(opts.roles ?? ['admin']),
      headers: { origin: opts.origin ?? ENV.APP_BASE_URL },
    }),
    res,
  )
  return res
}

// Columns of the audit insert, in statement order.
type AuditRow = {
  adminSub: unknown
  adminEmail: unknown
  method: unknown
  path: unknown
  action: unknown
  targetId: unknown
  summary: unknown
}
function auditRows(): AuditRow[] {
  return sqlCalls
    .filter((c) => c.sql.includes('insert into admin_audit_log'))
    .map(({ values: v }) => ({
      adminSub: v[0],
      adminEmail: v[1],
      method: v[2],
      path: v[3],
      action: v[4],
      targetId: v[5],
      summary: v[6],
    }))
}

// Rows shaped like each table's, so the accessors' mapRow has dates to parse.
const ANNOUNCEMENT_ROW = {
  id: ID, body: 'Save now', action_url: '/plus', bar_color: '#4a9fe8', text_color: '#ffffff',
  dismissible: true, enabled: true, starts_at: NOW, ends_at: NOW, created_at: NOW, updated_at: NOW,
}
const FAQ_ROW = {
  id: ID, key: 'how-to-cancel', question: 'How do I cancel?', answer: '<p>Easily.</p>',
  category: '', enabled: true, display_order: 0, created_at: NOW, updated_at: NOW,
}
const CAREER_ROW = {
  id: ID, slug: 'history-host', title: 'History Host', team: null, location: null,
  employment_type: null, summary: 'Host a show.', description: '<p>Host a show.</p>',
  apply_url: null, enabled: true, display_order: 0, created_at: NOW, updated_at: NOW,
}

// One responder for every table: writes return "their" row, deletes report one
// row gone, everything else (lists, settings upserts, the audit insert) is empty.
function respondAsIfRowsExist(sql: string): unknown[] {
  if (sql.includes('admin_audit_log')) return []
  if (/delete from (announcements|faqs|careers|discuss_threads)/.test(sql)) return [{ id: ID }]
  if (/(insert into|update) announcements/.test(sql)) return [ANNOUNCEMENT_ROW]
  if (/(insert into|update) faqs/.test(sql)) return [FAQ_ROW]
  if (/(insert into|update) careers/.test(sql)) return [CAREER_ROW]
  return []
}

const ANNOUNCEMENT_BODY = {
  body: 'Save now',
  actionUrl: '/plus',
  startsAt: '2026-05-01T00:00:00Z',
  endsAt: '2026-05-31T23:59:00Z',
}
const FAQ_BODY = { key: 'how-to-cancel', question: 'How do I cancel?', answer: '<p>Easily.</p>' }
const CAREER_BODY = {
  title: 'History Host',
  summary: 'Host a show.',
  description: '<p>Host a show.</p>',
}

silenceExpectedConsole()

// logAdminAction's console trail is console.log, which silenceExpectedConsole
// leaves alone; keep it out of the test output.
const originalLog = console.log
beforeEach(() => {
  sqlCalls.length = 0
  stripeCalls.length = 0
  nextSqlResult = (sql) => respondAsIfRowsExist(sql)
  console.log = () => {}
})
afterAll(() => {
  console.log = originalLog
})

describe('admin audit log — promos', () => {
  test('creating a promo records the code, the discount and the duration', async () => {
    const res = await call('POST', '/api/admin/promos', {
      body: { discountType: 'percent', percentOff: 100, duration: 'forever', code: 'free4ever' },
    })
    expect(res.statusCode).toBe(200)

    expect(auditRows()).toEqual([
      {
        adminSub: ADMIN_SUB,
        adminEmail: ADMIN_EMAIL,
        method: 'POST',
        path: '/api/admin/promos',
        action: 'promo.create',
        targetId: 'co_new',
        summary: 'code=FREE4EVER 100% off duration=forever',
      },
    ])
  })

  test('deleting a promo records what it was, read before the delete', async () => {
    const res = await call('DELETE', '/api/admin/promos?id=co_old')
    expect(res.statusCode).toBe(200)
    expect(stripeCalls).toContain('coupons.del')

    expect(auditRows()).toEqual([
      expect.objectContaining({
        method: 'DELETE',
        action: 'promo.delete',
        targetId: 'co_old',
        summary: 'name=Spring sale 15% off duration=repeating x3mo',
      }),
    ])
  })

  test('a rejected promo leaves no row', async () => {
    const res = await call('POST', '/api/admin/promos', {
      body: { discountType: 'percent', percentOff: 250, duration: 'once' },
    })
    expect(res.statusCode).toBe(400)
    expect(stripeCalls).toHaveLength(0)
    expect(auditRows()).toHaveLength(0)
  })
})

describe('admin audit log — who gets one', () => {
  test('a non-admin is refused and nothing is logged', async () => {
    const res = await call('POST', '/api/admin/faqs', { body: FAQ_BODY, roles: [] })
    expect(res.statusCode).toBe(403)
    expect(sqlCalls).toHaveLength(0)
  })

  test('a cross-origin admin mutation is refused and nothing is logged', async () => {
    const res = await call('POST', '/api/admin/faqs', {
      body: FAQ_BODY,
      origin: 'https://evil.example',
    })
    expect(res.statusCode).toBe(403)
    expect(sqlCalls).toHaveLength(0)
  })

  test('plain list reads of site content are not logged', async () => {
    for (const path of ['/api/admin/faqs', '/api/admin/careers', '/api/admin/announcements']) {
      expect((await call('GET', path)).statusCode).toBe(200)
    }
    expect(auditRows()).toHaveLength(0)
  })
})

describe('admin audit log — content CRUD', () => {
  const cases: {
    name: string
    path: string
    body: Record<string, unknown>
    summary: string
  }[] = [
    {
      name: 'announcement',
      path: '/api/admin/announcements',
      body: ANNOUNCEMENT_BODY,
      summary: 'enabled=true window=2026-05-01T00:00:00.000Z..2026-05-31T23:59:00.000Z',
    },
    {
      name: 'faq',
      path: '/api/admin/faqs',
      body: FAQ_BODY,
      summary: 'key=how-to-cancel enabled=true',
    },
    {
      name: 'career',
      path: '/api/admin/careers',
      body: CAREER_BODY,
      summary: 'slug=history-host enabled=true',
    },
  ]

  for (const c of cases) {
    test(`${c.name}: create, update and delete each leave one row`, async () => {
      expect((await call('POST', c.path, { body: c.body })).statusCode).toBe(200)
      expect((await call('PUT', `${c.path}?id=${ID}`, { body: c.body })).statusCode).toBe(200)
      expect((await call('DELETE', `${c.path}?id=${ID}`)).statusCode).toBe(200)

      expect(auditRows()).toEqual([
        expect.objectContaining({
          method: 'POST', path: c.path, action: `${c.name}.create`, targetId: ID, summary: c.summary,
        }),
        expect.objectContaining({
          method: 'PUT', path: c.path, action: `${c.name}.update`, targetId: ID, summary: c.summary,
        }),
        expect.objectContaining({
          method: 'DELETE', path: c.path, action: `${c.name}.delete`, targetId: ID, summary: null,
        }),
      ])
    })

    test(`${c.name}: a write that matched no row is a 404 and leaves no row`, async () => {
      nextSqlResult = () => []
      expect((await call('PUT', `${c.path}?id=${ID}`, { body: c.body })).statusCode).toBe(404)
      expect((await call('DELETE', `${c.path}?id=${ID}`)).statusCode).toBe(404)
      expect(auditRows()).toHaveLength(0)
    })

    // Was: the junk id reached Postgres, failed the uuid cast, and came back as
    // the catch-all's 500.
    test(`${c.name}: a non-UUID id is a 400 that never reaches the database`, async () => {
      for (const method of ['PUT', 'DELETE']) {
        const res = await call(method, `${c.path}?id=not-a-uuid`, { body: c.body })
        expect(res.statusCode).toBe(400)
        expect(res.__json()).toEqual({ error: 'invalid id format' })
      }
      expect(sqlCalls).toHaveLength(0)
    })
  }

  test('discuss thread: delete leaves a row; a non-UUID id is still a 400', async () => {
    const path = '/api/admin/discuss-threads'
    expect((await call('DELETE', `${path}?id=${ID}`)).statusCode).toBe(200)
    expect(auditRows()).toEqual([
      expect.objectContaining({ method: 'DELETE', action: 'discuss_thread.delete', targetId: ID }),
    ])

    const bad = await call('DELETE', `${path}?id=nope`)
    expect(bad.statusCode).toBe(400)
    expect(bad.__json()).toEqual({ error: 'invalid id format' })
  })
})

describe('admin audit log — settings', () => {
  const cases = [
    { path: '/api/admin/feed-reminders', body: DEFAULT_REMINDER_CONFIG, action: 'feed_reminders.update' },
    { path: '/api/admin/feed-migration', body: DEFAULT_MIGRATION_CONFIG, action: 'feed_migration.update' },
    { path: '/api/admin/open-houses', body: DEFAULT_OPEN_HOUSE_CONFIG, action: 'open_houses.update' },
  ]
  for (const c of cases) {
    test(`PUT ${c.path} leaves one ${c.action} row`, async () => {
      expect((await call('PUT', c.path, { body: c.body })).statusCode).toBe(200)
      expect(auditRows()).toEqual([
        expect.objectContaining({ method: 'PUT', path: c.path, action: c.action }),
      ])
    })

    test(`PUT ${c.path} with an invalid config leaves none`, async () => {
      expect((await call('PUT', c.path, { body: { enabled: 'yes' } })).statusCode).toBe(400)
      expect(auditRows()).toHaveLength(0)
    })
  }
})

describe('admin audit log — bulk reads of member data', () => {
  test('the cancellations CSV export records its filter and row count, not the rows', async () => {
    nextSqlResult = (sql) =>
      sql.includes('admin_audit_log')
        ? []
        : [
            {
              email: 'jane@example.com', reasons: ['too_expensive'], note: 'private note',
              offer_outcome: 'declined', coupon_id: null, canceled_tier: 'bundle',
              retained_product: null, created_at: NOW,
            },
          ]
    const res = await call('GET', '/api/admin/cancellations?format=csv&reason=too_expensive')
    expect(res.statusCode).toBe(200)
    expect(res.__headers()['content-type']).toContain('text/csv')

    const rows = auditRows()
    expect(rows).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/api/admin/cancellations',
        action: 'cancellations.export',
        summary: 'format=csv outcome=any reason=too_expensive rows=1',
      }),
    ])
    expect(JSON.stringify(rows)).not.toContain('jane@example.com')
    expect(JSON.stringify(rows)).not.toContain('private note')
  })

  test('the on-screen cancellation summary is not an export and is not logged', async () => {
    expect((await call('GET', '/api/admin/cancellations')).statusCode).toBe(200)
    expect(auditRows()).toHaveLength(0)
  })

  test('a member-directory search is logged without the email searched for', async () => {
    const res = await call('GET', '/api/admin/members?email=jane%40example.com')
    expect(res.statusCode).toBe(200)

    const rows = auditRows()
    expect(rows).toEqual([
      expect.objectContaining({
        path: '/api/admin/members',
        action: 'members.search',
        summary: 'by=email tier=any activation=any rows=1',
      }),
    ])
    expect(JSON.stringify(rows)).not.toContain('jane')
  })

  test('a member-directory page is logged with its filters and offset', async () => {
    const res = await call('GET', '/api/admin/members?tier=bundle&offset=50')
    expect(res.statusCode).toBe(200)
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'members.list',
        summary: 'tier=bundle activation=any offset=50 rows=0',
      }),
    ])
  })

  test('reading the support log is recorded by size', async () => {
    const res = await call('GET', '/api/admin/support-conversations')
    expect(res.statusCode).toBe(200)
    expect(auditRows()).toEqual([
      expect.objectContaining({ action: 'support_conversations.read', summary: 'rows=0' }),
    ])
  })
})

describe('an audit write that fails', () => {
  // Migration 0005 not applied yet: the mutation must still succeed.
  test('does not fail the mutation it describes', async () => {
    nextSqlResult = (sql) => {
      if (sql.includes('admin_audit_log')) {
        throw Object.assign(new Error('relation "admin_audit_log" does not exist'), {
          code: '42P01',
        })
      }
      return respondAsIfRowsExist(sql)
    }
    const res = await call('POST', '/api/admin/faqs', { body: FAQ_BODY })
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { faq: { id: string } }).faq.id).toBe(ID)
  })
})

describe('admin responses are uncacheable', () => {
  const paths = [
    '/api/admin/promos',
    '/api/admin/cancellations',
    '/api/admin/members',
    '/api/admin/feed-reminders',
    '/api/admin/feed-migration',
    '/api/admin/announcements',
    '/api/admin/faqs',
    '/api/admin/careers',
    '/api/admin/discuss-threads',
    '/api/admin/support-conversations',
  ]
  for (const path of paths) {
    test(`GET ${path} is private, no-store`, async () => {
      const res = await call('GET', path)
      expect(res.statusCode).toBe(200)
      expect(res.__headers()['cache-control']).toBe('private, no-store')
    })
  }
})
