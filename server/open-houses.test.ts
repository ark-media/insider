// Tests for the Open House surfaces.
//
// Same convention as the feed-reminder admin tests: the admin route's
// *authorized* path needs a real Auth0 token, so we test the 403 gate here and
// cover the logic it wraps — the settings round-trip and the public route's
// filtering — directly against the mocked Neon driver.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { ServerResponse } from 'node:http'
import {
  neonMockModule,
  type SqlCall,
  makeFakeReq,
  silenceExpectedConsole,
} from './test-utils'
import { DEFAULT_OPEN_HOUSE_CONFIG } from '../shared/open-house'

const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

import {
  __resetOpenHouseCacheForTests,
  openHouseRoutes,
} from './routes/open-houses'
import { getOpenHouseConfig, setOpenHouseConfig } from './lib/app-settings'
import { getDb } from './lib/db'
import type { Deps, Route } from './lib/route'

const PUBLIC_ROUTE = '/api/open-houses'
const ADMIN_ROUTE = '/api/admin/open-houses'
const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  DATABASE_URL: 'postgres://stub-open-houses',
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
  const route = openHouseRoutes(deps).find((r) => r.path === path)
  if (!route) throw new Error(`route ${path} not registered`)
  return route.handler
}

type FakeRes = ServerResponse & {
  __json: () => unknown
  __status: () => number
  __header: (name: string) => string | undefined
}
function makeRes(): FakeRes {
  let body = ''
  let statusCode = 200
  let ended = false
  const headers: Record<string, string> = {}
  return {
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
    __header: (name: string) => headers[name.toLowerCase()],
  } as unknown as FakeRes
}

// A row far enough out that it stays "upcoming" for the life of this test file.
const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString()
const PAST = new Date(Date.now() - 7 * 86_400_000).toISOString()

function storedConfig(sessions: unknown[]): unknown[] {
  return [{ value: JSON.stringify({ enabled: true, sessions }) }]
}

silenceExpectedConsole()

beforeEach(() => {
  sqlCalls.length = 0
  nextSqlResult = () => []
  // The public route caches the config for a minute, which would otherwise leak
  // one case's schedule into the next.
  __resetOpenHouseCacheForTests()
})

// ===========================================================================
// Admin gate
// ===========================================================================

describe('admin/open-houses gate', () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    test(`${method} without a bearer token is 403`, async () => {
      const handler = findHandler(buildDeps(), ADMIN_ROUTE)
      const res = makeRes()
      await handler(makeFakeReq({ url: ADMIN_ROUTE, method }), res)
      expect(res.__status()).toBe(403)
      expect(res.__json()).toEqual({ error: 'forbidden' })
    })
  }
})

// ===========================================================================
// The app_settings round-trip
// ===========================================================================

describe('setOpenHouseConfig', () => {
  test('upserts the config as JSON under open_house_config', async () => {
    const config = {
      enabled: true,
      sessions: [
        { id: 'a', startsAt: FUTURE, durationMinutes: 45, rsvpUrl: 'https://zoom.us/j/1' },
      ],
    }
    await setOpenHouseConfig(getDb(BASE_ENV), config)
    const write = sqlCalls.find((c) => c.sql.includes('insert into app_settings'))
    expect(write).toBeDefined()
    expect(write!.sql).toContain('on conflict (key) do update')
    expect(write!.values).toContain('open_house_config')
    expect(write!.values).toContain(JSON.stringify(config))
  })
})

describe('getOpenHouseConfig', () => {
  test('no row → the shipped default', async () => {
    nextSqlResult = () => []
    expect(await getOpenHouseConfig(getDb(BASE_ENV))).toEqual(
      DEFAULT_OPEN_HOUSE_CONFIG,
    )
  })

  test('a stored row wins over the default', async () => {
    nextSqlResult = () => storedConfig([{ id: 'x', startsAt: FUTURE, durationMinutes: 30 }])
    const config = await getOpenHouseConfig(getDb(BASE_ENV))
    expect(config.sessions.map((s) => s.id)).toEqual(['x'])
  })

  test('a read failure propagates — a blip must not re-advertise the seeded date', async () => {
    nextSqlResult = () => {
      throw new Error('neon is down')
    }
    expect(getOpenHouseConfig(getDb(BASE_ENV))).rejects.toThrow('neon is down')
  })

  test('a malformed row falls back rather than throwing — a bad row must not break the page', async () => {
    nextSqlResult = () => [{ value: '{ not json' }]
    expect(await getOpenHouseConfig(getDb(BASE_ENV))).toEqual(
      DEFAULT_OPEN_HOUSE_CONFIG,
    )
  })

  test('a row that no longer validates falls back too', async () => {
    nextSqlResult = () => [{ value: JSON.stringify({ enabled: 'yes', sessions: [] }) }]
    expect(await getOpenHouseConfig(getDb(BASE_ENV))).toEqual(
      DEFAULT_OPEN_HOUSE_CONFIG,
    )
  })
})

// ===========================================================================
// The public route — ungated, and never serves a session that is over
// ===========================================================================

describe('GET /api/open-houses', () => {
  test('serves only upcoming sessions, edge-cacheable', async () => {
    nextSqlResult = () =>
      storedConfig([
        { id: 'past', startsAt: PAST, durationMinutes: 45 },
        { id: 'soon', startsAt: FUTURE, durationMinutes: 45 },
      ])
    const handler = findHandler(buildDeps(), PUBLIC_ROUTE)
    const res = makeRes()
    await handler(makeFakeReq({ url: PUBLIC_ROUTE, method: 'GET' }), res)

    expect(res.__status()).toBe(200)
    const body = res.__json() as { sessions: { id: string }[] }
    expect(body.sessions.map((s) => s.id)).toEqual(['soon'])
    expect(res.__header('cache-control')).toContain('s-maxage=60')
  })

  test('a DB failure hides the section rather than erroring the page', async () => {
    nextSqlResult = () => {
      throw new Error('neon is down')
    }
    const handler = findHandler(buildDeps(), PUBLIC_ROUTE)
    const res = makeRes()
    await handler(makeFakeReq({ url: PUBLIC_ROUTE, method: 'GET' }), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ sessions: [] })
  })

  test('is read-only', async () => {
    const handler = findHandler(buildDeps(), PUBLIC_ROUTE)
    const res = makeRes()
    await handler(makeFakeReq({ url: PUBLIC_ROUTE, method: 'POST' }), res)
    expect(res.__status()).toBe(405)
  })
})
