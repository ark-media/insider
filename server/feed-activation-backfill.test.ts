// Tests for the download-derived activation backfill: the pure dedupe fold, the
// bulk DB write, the orchestrator over a paged download stream, and the admin
// route's auth gate.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  neonMockModule,
  type SqlCall,
 silenceExpectedConsole } from './test-utils'

// --- Neon mock -------------------------------------------------------------
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string, values: unknown[]) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged, values) => nextSqlResult(merged, values)),
)

import { foldDownloadPage, runFeedActivationBackfill } from './lib/feed-activation-backfill'
import { backfillActivations, type ActivationSeed } from './lib/feed-activations'
import {
  adminFeedActivationRoutes,
  resolveBackfillSince,
} from './routes/admin-feed-activations'
import { getDb } from './lib/db'
import type { ScDownload, ScV1Client } from './lib/sc-client'
import type { Deps, Route } from './lib/route'

silenceExpectedConsole()

beforeEach(() => {
  sqlCalls.length = 0
  nextSqlResult = () => []
})

// ===========================================================================
// foldDownloadPage (pure dedupe)
// ===========================================================================

describe('foldDownloadPage', () => {
  test('dedupes to one seed per (email, feed), keeping the earliest download', () => {
    const acc = new Map<string, ActivationSeed>()
    foldDownloadPage(acc, [
      { email: 'a@x.com', feed_id: 10, downloaded_at: '2026-05-01T00:00:00Z' },
      { email: 'a@x.com', feed_id: 10, downloaded_at: '2026-03-01T00:00:00Z' }, // earlier
      { email: 'a@x.com', feed_id: 20, downloaded_at: '2026-04-01T00:00:00Z' },
    ])
    const seeds = [...acc.values()]
    expect(seeds).toHaveLength(2)
    const f10 = seeds.find((s) => s.feedId === 10)
    expect(f10?.activatedAt).toBe('2026-03-01T00:00:00Z')
  })

  test('normalizes email and accepts numeric-string feed ids', () => {
    const acc = new Map<string, ActivationSeed>()
    foldDownloadPage(acc, [{ email: '  A@X.COM ', feed_id: '99', downloaded_at: '2026-01-01T00:00:00Z' }])
    const seed = [...acc.values()][0]!
    expect(seed.email).toBe('a@x.com')
    expect(seed.feedId).toBe(99)
  })

  test('folds across multiple pages into the same accumulator', () => {
    const acc = new Map<string, ActivationSeed>()
    foldDownloadPage(acc, [{ email: 'a@x.com', feed_id: 10, downloaded_at: '2026-05-01T00:00:00Z' }])
    foldDownloadPage(acc, [{ email: 'a@x.com', feed_id: 10, downloaded_at: '2026-02-01T00:00:00Z' }])
    expect(acc.size).toBe(1)
    expect([...acc.values()][0]!.activatedAt).toBe('2026-02-01T00:00:00Z')
  })

  test('skips rows missing email or feed id', () => {
    const acc = new Map<string, ActivationSeed>()
    foldDownloadPage(acc, [
      { feed_id: 10, downloaded_at: '2026-01-01T00:00:00Z' } as ScDownload,
      { email: 'a@x.com', downloaded_at: '2026-01-01T00:00:00Z' } as ScDownload,
      { email: 'a@x.com', feed_id: 0, downloaded_at: '2026-01-01T00:00:00Z' },
    ])
    expect(acc.size).toBe(0)
  })

  test('a missing timestamp never displaces a known earliest', () => {
    const acc = new Map<string, ActivationSeed>()
    foldDownloadPage(acc, [{ email: 'a@x.com', feed_id: 10, downloaded_at: '2026-02-01T00:00:00Z' }])
    foldDownloadPage(acc, [{ email: 'a@x.com', feed_id: 10 }])
    expect([...acc.values()][0]!.activatedAt).toBe('2026-02-01T00:00:00Z')
  })
})

// ===========================================================================
// backfillActivations (bulk insert)
// ===========================================================================

describe('backfillActivations', () => {
  test('emits an unnest insert with the seed arrays; returns rows inserted', async () => {
    nextSqlResult = (sql) => (sql.includes('insert into sc_feed_activations') ? [{ feed_id: 10 }, { feed_id: 20 }] : [])
    const seeds: ActivationSeed[] = [
      { email: 'a@x.com', feedId: 10, activatedAt: '2026-01-01T00:00:00Z' },
      { email: 'b@x.com', feedId: 20, activatedAt: null },
    ]
    const inserted = await backfillActivations(getDb({ DATABASE_URL: 'x' }), seeds)
    expect(inserted).toBe(2)
    const call = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(call!.sql).toContain('unnest')
    expect(call!.sql).toContain('on conflict (email, feed_id) do nothing')
    expect(call!.values[0]).toEqual(['a@x.com', 'b@x.com'])
    expect(call!.values[1]).toEqual([10, 20])
  })

  test('chunks large seed lists into multiple inserts', async () => {
    nextSqlResult = () => []
    const seeds: ActivationSeed[] = Array.from({ length: 2500 }, (_, i) => ({
      email: `u${i}@x.com`,
      feedId: i + 1,
      activatedAt: null,
    }))
    await backfillActivations(getDb({ DATABASE_URL: 'x' }), seeds, 1000)
    const inserts = sqlCalls.filter((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(inserts).toHaveLength(3) // 1000 + 1000 + 500
    expect((inserts[0]!.values[0] as string[]).length).toBe(1000)
    expect((inserts[2]!.values[0] as string[]).length).toBe(500)
  })

  test('no seeds → no query, zero inserted', async () => {
    const inserted = await backfillActivations(getDb({ DATABASE_URL: 'x' }), [])
    expect(inserted).toBe(0)
    expect(sqlCalls).toHaveLength(0)
  })

  test('normalizes emails so a mixed-case seed cannot dodge the PK', async () => {
    nextSqlResult = () => []
    await backfillActivations(getDb({ DATABASE_URL: 'x' }), [
      { email: '  Mixed@Case.COM ', feedId: 10, activatedAt: null },
    ])
    const call = sqlCalls.find((c) => c.sql.includes('insert into sc_feed_activations'))
    expect(call!.values[0]).toEqual(['mixed@case.com'])
  })
})

// ===========================================================================
// runFeedActivationBackfill (orchestrator over a fake paged stream)
// ===========================================================================

describe('runFeedActivationBackfill', () => {
  test('pages downloads, dedupes, and bulk-inserts', async () => {
    // Fake SC v1 client: two pages of downloads, then stop.
    const pages: Record<number, unknown> = {
      1: {
        current_page: 1,
        last_page: 2,
        data: [
          { email: 'a@x.com', feed_id: 10, downloaded_at: '2026-05-01T00:00:00Z' },
          { email: 'a@x.com', feed_id: 10, downloaded_at: '2026-03-01T00:00:00Z' },
        ],
      },
      2: {
        current_page: 2,
        last_page: 2,
        data: [{ email: 'b@x.com', feed_id: 20, downloaded_at: '2026-04-01T00:00:00Z' }],
      },
    }
    const sc: ScV1Client = {
      call: (async (_m: string, path: string) => {
        const p = Number(new URL(`http://x${path}`).searchParams.get('page'))
        return pages[p]
      }) as ScV1Client['call'],
    }
    // Insert returns one row per unique pair passed.
    nextSqlResult = (sql, values) =>
      sql.includes('insert into sc_feed_activations')
        ? (values[0] as string[]).map((_, i) => ({ feed_id: i }))
        : []

    const summary = await runFeedActivationBackfill({ sql: getDb({ DATABASE_URL: 'x' }), sc })
    expect(summary.pages).toBe(2)
    expect(summary.downloadsScanned).toBe(3)
    expect(summary.pairs).toBe(2) // (a,10) deduped + (b,20)
    expect(summary.inserted).toBe(2)
  })
})

// ===========================================================================
// Admin route gate
// ===========================================================================

function buildDeps(env: Record<string, string>): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: env.APP_BASE_URL ?? 'https://ark.example',
    activator: {} as Deps['activator'],
  }
}
function findHandler(deps: Deps): Route['handler'] {
  const route = adminFeedActivationRoutes(deps).find(
    (r) => r.path === '/api/admin/backfill-feed-activations',
  )
  if (!route) throw new Error('route not registered')
  return route.handler
}
function makeReq(method: string): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = method
  stream.url = '/api/admin/backfill-feed-activations'
  stream.headers = { 'content-type': 'application/json' }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}
function makeRes() {
  let body = ''
  let statusCode = 200
  let ended = false
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
    setHeader() {},
    getHeader() {
      return undefined
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === 'string' ? chunk : chunk.toString()
      ended = true
    },
    __status: () => statusCode,
    __json: () => JSON.parse(body) as unknown,
  } as unknown as ServerResponse & { __status: () => number; __json: () => unknown }
}

describe('admin backfill route gate', () => {
  test('POST without a bearer token is 403', async () => {
    const handler = findHandler(buildDeps({ APP_BASE_URL: 'https://ark.example', DATABASE_URL: 'x' }))
    const res = makeRes()
    await handler(makeReq('POST'), res as ServerResponse)
    expect(res.__status()).toBe(403)
    expect(res.__json()).toEqual({ error: 'forbidden' })
  })
})

// ===========================================================================
// resolveBackfillSince — the sinceDays validation the route wraps (tested
// directly, per the "authorized route path isn't unit-tested" convention).
// ===========================================================================

describe('resolveBackfillSince', () => {
  const NOW = Date.parse('2026-07-16T00:00:00Z')

  test('omitted sinceDays → scan all history (no lower bound)', () => {
    const r = resolveBackfillSince(undefined, NOW)
    expect(r).toEqual({ ok: true })
  })

  test('a positive sinceDays → lower-bound ISO that many days back', () => {
    const r = resolveBackfillSince(30, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fromIso).toBe(new Date(NOW - 30 * 86_400_000).toISOString())
    }
  })

  test('numeric-string sinceDays is accepted', () => {
    const r = resolveBackfillSince('7', NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fromIso).toBe(new Date(NOW - 7 * 86_400_000).toISOString())
  })

  test.each([0, -5, Number.NaN, Infinity, 'abc'])(
    'rejects non-positive / non-finite sinceDays (%p) → error',
    (bad) => {
      const r = resolveBackfillSince(bad, NOW)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('positive')
    },
  )
})
