// Tests for the feed-reminder admin surface.
//
// Following the careers/announcements convention, the admin route's *authorized*
// DB path isn't unit-tested (it needs a real Auth0 admin token + connection);
// we test the 403 gate here and cover the logic it wraps — getReminderConfig
// precedence and setReminderConfig — directly against the mocked Neon driver.

import {
  describe,
  test,
  expect,
  beforeEach,
  mock,
} from 'bun:test'
import type { ServerResponse } from 'node:http'
import {
  neonMockModule,
  type SqlCall,
 makeFakeReq, silenceExpectedConsole } from './test-utils'
import { DEFAULT_REMINDER_CONFIG } from '../shared/feed-reminder'

// --- Neon mock (harmless if it leaks: tests never hit a real DB) -----------
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

import { adminFeedReminderRoutes } from './routes/admin-feed-reminders'
import { getReminderConfig, setReminderConfig } from './lib/app-settings'
import { getDb } from './lib/db'
import type { Deps, Route } from './lib/route'

const ROUTE = '/api/admin/feed-reminders'
const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  DATABASE_URL: 'postgres://stub-admin-feed-reminders',
}

function buildDeps(env: Record<string, string> = BASE_ENV): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: env.APP_BASE_URL ?? 'https://ark.example',
    activator: {} as Deps['activator'],
  }
}

function findHandler(deps: Deps, path: string): Route['handler'] {
  const route = adminFeedReminderRoutes(deps).find((r) => r.path === path)
  if (!route) throw new Error(`route ${path} not registered`)
  return route.handler
}

function makeReq(opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return makeFakeReq({ url: ROUTE, ...opts })
}

type FakeRes = ServerResponse & { __json: () => unknown; __status: () => number }
function makeRes(): FakeRes {
  let body = ''
  let statusCode = 200
  let ended = false
  const headers: Record<string, string> = {}
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
    __status: () => statusCode,
  } as unknown as FakeRes
  return res
}

silenceExpectedConsole()

beforeEach(() => {
  sqlCalls.length = 0
  nextSqlResult = () => []
})

// ===========================================================================
// Admin gate — no token → 403 (requireAdmin runs for real)
// ===========================================================================

describe('admin/feed-reminders gate', () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    test(`${method} without a bearer token is 403`, async () => {
      const handler = findHandler(buildDeps(), ROUTE)
      const res = makeRes()
      await handler(makeReq({ method }), res)
      expect(res.__status()).toBe(403)
      expect(res.__json()).toEqual({ error: 'forbidden' })
    })
  }
})

// ===========================================================================
// setReminderConfig — writes the JSON blob under the settings key
// ===========================================================================

describe('setReminderConfig', () => {
  test('upserts the config as JSON under feed_reminder_config', async () => {
    const cfg = { enabled: true, delayHours: 12, windowDays: 21, onlyIfNoneSetUp: false }
    await setReminderConfig(getDb(BASE_ENV), cfg)
    const write = sqlCalls.find((c) => c.sql.includes('insert into app_settings'))
    expect(write).toBeDefined()
    expect(write!.sql).toContain('on conflict (key) do update')
    expect(write!.values).toContain('feed_reminder_config')
    expect(write!.values).toContain(JSON.stringify(cfg))
  })
})

// ===========================================================================
// getReminderConfig precedence: DB row → env → defaults
// ===========================================================================

describe('getReminderConfig precedence', () => {
  test('no row → defaults', async () => {
    nextSqlResult = () => []
    const cfg = await getReminderConfig(getDb(BASE_ENV), BASE_ENV)
    expect(cfg).toEqual(DEFAULT_REMINDER_CONFIG)
  })

  test('stored row is returned as-is', async () => {
    const stored = { enabled: false, delayHours: 48, windowDays: 30, onlyIfNoneSetUp: false }
    nextSqlResult = (sql) =>
      sql.includes('from app_settings') ? [{ value: JSON.stringify(stored) }] : []
    const cfg = await getReminderConfig(getDb(BASE_ENV), BASE_ENV)
    expect(cfg).toEqual(stored)
  })

  test('DB row wins over env overrides', async () => {
    const stored = { enabled: false, delayHours: 5, windowDays: 5, onlyIfNoneSetUp: false }
    nextSqlResult = (sql) =>
      sql.includes('from app_settings') ? [{ value: JSON.stringify(stored) }] : []
    const cfg = await getReminderConfig(getDb(BASE_ENV), {
      ...BASE_ENV,
      FEED_REMINDER_DELAY_HOURS: '99',
    })
    expect(cfg).toEqual(stored)
  })

  test('falls back to env when no row', async () => {
    nextSqlResult = () => []
    const cfg = await getReminderConfig(getDb(BASE_ENV), {
      ...BASE_ENV,
      FEED_REMINDER_DELAY_HOURS: '72',
    })
    expect(cfg.delayHours).toBe(72)
  })

  test('falls back to defaults when the stored row is malformed JSON', async () => {
    nextSqlResult = (sql) =>
      sql.includes('from app_settings') ? [{ value: '{ not json' }] : []
    const cfg = await getReminderConfig(getDb(BASE_ENV), BASE_ENV)
    expect(cfg).toEqual(DEFAULT_REMINDER_CONFIG)
  })

  test('falls back when the stored row fails validation', async () => {
    const invalid = { enabled: true, delayHours: 999999, windowDays: 1, onlyIfNoneSetUp: true }
    nextSqlResult = (sql) =>
      sql.includes('from app_settings') ? [{ value: JSON.stringify(invalid) }] : []
    const cfg = await getReminderConfig(getDb(BASE_ENV), BASE_ENV)
    expect(cfg).toEqual(DEFAULT_REMINDER_CONFIG)
  })
})
