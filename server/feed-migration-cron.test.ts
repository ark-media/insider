// Wiring tests for /api/cron/feed-migration-reminders — the escalating check-in
// series. Drives the handler through the dev-api plugin with the Neon driver and
// outbound fetch (Resend) mocked, so the orchestrator runs end to end without a
// live DB or email. Mirrors feed-reminders-cron.test.ts.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import {
  neonMockModule,
  type SqlCall,
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  parseJsonInitBody,
  type Middleware,
} from './test-utils'

const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

import { clearPremiumShowCache } from './lib/beehiiv-feeds'
import { devApiPlugin } from './dev-api'
import { MIGRATION_REMINDER_NO } from '../shared/feed-migration'

const PATH = '/api/cron/feed-migration-reminders'
const CRON_SECRET = 'cron-secret-abcdef0123456789'
const SHOW_ID = 'pod_premium-show'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  // The premium show set is discovered from Beehiiv, so these two are what
  // the run depends on — there is no show id to configure any more.
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test',
  CRON_SECRET,
  RESEND_API_KEY: 'rk_test',
  DATABASE_URL: 'postgres://stub-feed-migration-cron',
}

function envWithout(key: string): Record<string, string> {
  const copy = { ...BASE_ENV }
  delete copy[key]
  return copy
}

function getHandler(env = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(PATH)
}

function req(opts: { method?: string; auth?: string } = {}) {
  return makeFakeReq({
    method: opts.method ?? 'POST',
    url: PATH,
    headers: { authorization: opts.auth ?? `Bearer ${CRON_SECRET}` },
  })
}

type FetchCall = { url: string; init?: RequestInit }
const originalFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []
let resendStatus = 200

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  // The publication's podcast list — how the premium show set is discovered.
  if (url.includes('/podcasts?')) {
    return new Response(
      JSON.stringify({ data: [{ id: SHOW_ID, status: 'live' }] }),
      { status: 200 },
    )
  }
  if (url.includes('api.resend.com')) {
    const ok = resendStatus >= 200 && resendStatus < 300
    return new Response(ok ? '{"id":"email_1"}' : '{"error":"boom"}', { status: resendStatus })
  }
  return new Response('{}', { status: 200 })
}) as typeof fetch

function resendCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.url.includes('api.resend.com'))
}

silenceExpectedConsole()

// The campaign config as stored in app_settings. Dates are far in the past so
// the stage is decided by `nowMs` (real time) rather than by the calendar.
function storedConfig(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    enabled: true,
    launchDate: '2020-01-01',
    deadlineDate: '2099-12-31',
    firstCheckInDays: 30,
    secondCheckInDays: 60,
    finalNoticeDays: 5,
    ...over,
  })
}

function stageRun(opts: {
  config?: string | null
  roster?: Array<{ email: string; status: string | null }>
  alreadySent?: boolean
  activatedShows?: string[]
}) {
  nextSqlResult = (sql) => {
    if (sql.includes('from app_settings')) {
      const v = opts.config === undefined ? storedConfig() : opts.config
      return v === null ? [] : [{ value: v }]
    }
    if (sql.includes('from beehiiv_subscription')) {
      return opts.roster ?? [{ email: 'migrated@example.com', status: 'active' }]
    }
    if (sql.includes('from feed_reminder_sends')) {
      return opts.alreadySent ? [{ '?column?': 1 }] : []
    }
    if (sql.includes('from beehiiv_feed_activations')) {
      return (opts.activatedShows ?? []).map((show_id) => ({ show_id, activated_at: null }))
    }
    return []
  }
}

beforeEach(() => {
  sqlCalls.length = 0
  fetchCalls = []
  nextSqlResult = () => []
  resendStatus = 200
  // The discovered premium-show set is process-global with its own TTL, so a
  // case that breaks the Beehiiv config would otherwise be answered from the
  // previous case's cache.
  clearPremiumShowCache()
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('guards', () => {
  test('405 on an unsupported method', async () => {
    const res = makeRes()
    await runHandler(getHandler(), req({ method: 'DELETE' }), res)
    expect(res.statusCode).toBe(405)
  })

  test('401 on a wrong secret, and nothing is sent', async () => {
    stageRun({})
    const res = makeRes()
    await runHandler(getHandler(), req({ auth: 'Bearer nope' }), res)
    expect(res.statusCode).toBe(401)
    expect(resendCalls()).toHaveLength(0)
  })

  test('500 when CRON_SECRET, DATABASE_URL or the Beehiiv key is unset', async () => {
    for (const key of ['CRON_SECRET', 'DATABASE_URL', 'BEEHIIV_API_KEY']) {
      // A roster per iteration: without the Beehiiv key the premium set can't
      // be discovered, and that only matters — and only fails — when there is
      // somebody to chase.
      stageRun({})
      const res = makeRes()
      await runHandler(getHandler(envWithout(key)), req(), res)
      expect(res.statusCode).toBe(500)
    }
  })
})

describe('run', () => {
  test('a migrated member who never set up gets the due stage, and a ledger row', async () => {
    stageRun({})
    const res = makeRes()
    await runHandler(getHandler(), req(), res)

    expect(res.statusCode).toBe(200)
    const summary = res.__json() as Record<string, unknown>
    // Launch was 2020, deadline 2099, so the second check-in is the latest due.
    expect(summary).toMatchObject({ enabled: true, stage: 'check_in_60', sent: 1 })

    const sends = resendCalls()
    expect(sends).toHaveLength(1)
    const body = parseJsonInitBody(sends[0]!.init) as Record<string, unknown>
    expect(body.to).toBe('migrated@example.com')
    expect(body.subject).toBe("You're about to lose early access to Call me Back")
    expect(String(body.html)).toContain('https://ark.example/setup')
    expect(String(body.html)).toContain('December 31, 2099')

    const write = sqlCalls.find((c) => c.sql.includes('insert into feed_reminder_sends'))
    expect(write).toBeDefined()
    // Stage 2 of the series, never the setup reminder's row.
    expect(write!.values).toContain(MIGRATION_REMINDER_NO.check_in_60)
  })

  test('a member who already set the feed up is left alone', async () => {
    stageRun({ activatedShows: [SHOW_ID] })
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    expect(res.__json()).toMatchObject({ eligible: 0, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
  })

  test('a stage already sent is not resent', async () => {
    stageRun({ alreadySent: true })
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    expect(res.__json()).toMatchObject({ eligible: 0, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
  })

  test('an unsubscribed reader is never mailed', async () => {
    stageRun({ roster: [{ email: 'gone@example.com', status: 'unsubscribed' }] })
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    expect(res.__json()).toMatchObject({ eligible: 0, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
  })

  test('no stage due yet → the roster is never even loaded', async () => {
    // The campaign launched yesterday; the first check-in is 30 days out.
    const soon = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    stageRun({ config: storedConfig({ launchDate: soon }) })
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    expect(res.__json()).toMatchObject({ enabled: true, stage: null, scanned: 0 })
    expect(sqlCalls.some((c) => c.sql.includes('from beehiiv_subscription'))).toBe(false)
    expect(resendCalls()).toHaveLength(0)
  })

  test('the campaign goes quiet after the deadline', async () => {
    stageRun({ config: storedConfig({ launchDate: '2020-01-01', deadlineDate: '2021-01-01' }) })
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    expect(res.__json()).toMatchObject({ stage: null, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
  })

  test('disabled sends nothing', async () => {
    stageRun({ config: storedConfig({ enabled: false }) })
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    expect(res.__json()).toMatchObject({ enabled: false, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
  })

  test('a malformed stored config falls back to the defaults rather than throwing', async () => {
    stageRun({ config: '{"enabled":"yes"}' })
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    // Defaults are a 2026 launch with a 2026-12-31 deadline, so by now the
    // campaign is over — the point is that the run completes instead of 500ing.
    expect(res.statusCode).toBe(200)
  })

  test('a send failure leaves the ledger untouched so the next run retries', async () => {
    stageRun({})
    resendStatus = 500
    const res = makeRes()
    await runHandler(getHandler(), req(), res)
    expect(res.__json()).toMatchObject({ eligible: 1, sent: 0, failed: 1 })
    expect(sqlCalls.some((c) => c.sql.includes('insert into feed_reminder_sends'))).toBe(false)
  })
})
