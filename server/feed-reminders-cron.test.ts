// Wiring tests for POST/GET /api/cron/feed-setup-reminders.
//
// Exercises the handler through the dev-api plugin with the Neon driver and
// outbound fetch (Resend) mocked, so the full orchestrator runs without a live
// DB or email. The roster is now a Neon query over the premium newsletter
// mirror rather than a paged upstream roster, so it is staged in the sql mock.
// Covers auth/config guards and the happy path: an in-window member who never
// activated gets one reminder and a ledger row.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test'
import {
  neonMockModule,
  type SqlCall,
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes as makeRes,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

// --- Neon mock -------------------------------------------------------------
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

import { devApiPlugin } from './dev-api'

// --- Plugin harness --------------------------------------------------------
const CRON_PATH = '/api/cron/feed-setup-reminders'
const CRON_SECRET = 'cron-secret-abcdef0123456789'

const SHOW_ID = 'pod_premium-show'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK: SHOW_ID,
  CRON_SECRET,
  RESEND_API_KEY: 'rk_test',
  DATABASE_URL: 'postgres://stub-feed-reminders-cron',
  // Reminders are opt-in (DEFAULT_REMINDER_CONFIG.enabled is false); the run
  // tests exercise the enabled path, so turn it on here. The disabled path has
  // its own test that overrides this to 'false'.
  FEED_REMINDER_ENABLED: 'true',
}

function envWithout(key: string): Record<string, string> {
  const copy = { ...BASE_ENV }
  delete copy[key]
  return copy
}

function buildHandler(env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(CRON_PATH)
}

// --- Fake req --------------------------------------------------------------
// `auth` is the full Authorization header value (default: the cron secret).
function makeReq(opts: { method?: string; auth?: string } = {}) {
  return makeFakeReq({
    method: opts.method ?? 'POST',
    url: CRON_PATH,
    headers: { authorization: opts.auth ?? `Bearer ${CRON_SECRET}` },
  })
}

// --- Outbound fetch mock (Resend) -----------------------------------------
type FetchCall = { url: string; init?: RequestInit }
const originalFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []
// Resend HTTP status — flip to a non-2xx to exercise the send-failure path.
let resendStatus = 200

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  if (url.includes('api.resend.com')) {
    const ok = resendStatus >= 200 && resendStatus < 300
    return new Response(ok ? '{"id":"email_1"}' : '{"error":"boom"}', {
      status: resendStatus,
    })
  }
  return new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()

const DAY = 86_400_000
function inWindowJoined(): string {
  return new Date(Date.now() - 3 * DAY).toISOString()
}

// One premium reader, as the roster query returns them.
type RosterRow = { email: string; status: string | null; premium_since: string | null }
function reader(over: Partial<RosterRow> = {}): RosterRow {
  return {
    email: 'reader@x.com',
    status: 'active',
    premium_since: inWindowJoined(),
    ...over,
  }
}

// Stage the roster query plus, optionally, the ledger and activation reads.
// The roster is bounded in SQL, so a row staged here is one the query returned.
function stageRun(opts: {
  roster?: RosterRow[]
  alreadySent?: boolean
  activatedShows?: string[]
}) {
  nextSqlResult = (sql) => {
    if (sql.includes('from beehiiv_subscription') && sql.includes('has_premium')) {
      return opts.roster ?? []
    }
    if (sql.includes('from feed_reminder_sends')) {
      return opts.alreadySent ? [{ '?column?': 1 }] : []
    }
    if (sql.includes('from beehiiv_feed_activations')) {
      return (opts.activatedShows ?? []).map((show_id) => ({
        show_id,
        activated_at: null,
      }))
    }
    return []
  }
}

beforeEach(() => {
  sqlCalls.length = 0
  fetchCalls = []
  nextSqlResult = () => []
  resendStatus = 200
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// ===========================================================================
// Auth + config guards
// ===========================================================================

describe('feed-setup-reminders auth + config', () => {
  test('405 on unsupported method', async () => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ method: 'DELETE' }), res)
    expect(res.statusCode).toBe(405)
  })

  test('401 on wrong secret', async () => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ auth: 'Bearer nope' }), res)
    expect(res.statusCode).toBe(401)
    expect(fetchCalls).toHaveLength(0)
  })

  test('500 when CRON_SECRET unset', async () => {
    const res = makeRes()
    await runHandler(buildHandler(envWithout('CRON_SECRET')), makeReq({}), res)
    expect(res.statusCode).toBe(500)
  })

  test('500 when DATABASE_URL unset', async () => {
    const res = makeRes()
    await runHandler(buildHandler(envWithout('DATABASE_URL')), makeReq({}), res)
    expect(res.statusCode).toBe(500)
  })
})

// ===========================================================================
// Orchestration
// ===========================================================================

describe('feed-setup-reminders run', () => {
  test('empty roster → 200 with zero counts, no email', async () => {
    stageRun({ roster: [] })
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ enabled: true, scanned: 0, sent: 0 })
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('in-window member who never activated → one reminder + ledger row', async () => {
    stageRun({ roster: [reader({ email: 'Reader@X.com' })] })

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({
      enabled: true,
      scanned: 1,
      eligible: 1,
      sent: 1,
      failed: 0,
    })

    // Resend called once, to the normalized address.
    const resend = fetchCalls.filter((c) => c.url.includes('resend'))
    expect(resend).toHaveLength(1)
    const sentBody = JSON.parse(resend[0]!.init?.body as string) as {
      to: string
      subject: string
    }
    expect(sentBody.to).toBe('reader@x.com')
    expect(sentBody.subject).toContain('Finish setting up')

    // Ledger insert happened with the normalized email.
    const insert = sqlCalls.find((c) => c.sql.includes('insert into feed_reminder_sends'))
    expect(insert).toBeDefined()
    expect(insert!.values).toContain('reader@x.com')
  })

  test('member already in the ledger is skipped (no email)', async () => {
    stageRun({ roster: [reader({ email: 'seen@x.com' })], alreadySent: true })

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ sent: 0 })
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
    expect(sqlCalls.some((c) => c.sql.includes('insert into feed_reminder_sends'))).toBe(
      false,
    )
  })

  test('a member who activated the show is skipped', async () => {
    stageRun({
      roster: [reader({ email: 'done@x.com' })],
      activatedShows: [SHOW_ID],
    })

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ scanned: 1, eligible: 0, sent: 0 })
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('an activation on a DIFFERENT show does not suppress the reminder', async () => {
    // Activation is per show; another show's row must not count as this one.
    stageRun({
      roster: [reader({ email: 'other@x.com' })],
      activatedShows: ['pod_some-other-show'],
    })

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.__json()).toMatchObject({ eligible: 1, sent: 1 })
  })

  test('an unsubscribed reader is gated out', async () => {
    stageRun({ roster: [reader({ email: 'gone@x.com', status: 'unsubscribed' })] })

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.__json()).toMatchObject({ scanned: 1, eligible: 0, sent: 0 })
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('disabled config → short-circuits before touching the roster', async () => {
    const env = { ...BASE_ENV, FEED_REMINDER_ENABLED: 'false' }
    // A member who WOULD be reminded if enabled — proves the guard, not an
    // empty roster, is what stops the send.
    stageRun({ roster: [reader({ email: 'a@x.com' })] })

    const res = makeRes()
    await runHandler(buildHandler(env), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ enabled: false, sent: 0 })
    // No roster query and no email when disabled.
    expect(
      sqlCalls.some(
        (c) => c.sql.includes('from beehiiv_subscription') && c.sql.includes('has_premium'),
      ),
    ).toBe(false)
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('500 when the premium show is unconfigured', async () => {
    // Without a show id there is nothing to ask "did they set it up?" about,
    // and every member would look un-activated. Refuse rather than mass-nudge.
    stageRun({ roster: [reader()] })
    const res = makeRes()
    await runHandler(buildHandler(envWithout('BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK')), makeReq({}), res)
    expect(res.statusCode).toBe(500)
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('Resend failure → counted as failed, ledger NOT written so it retries', async () => {
    resendStatus = 500
    stageRun({ roster: [reader({ email: 'fail@x.com' })] })

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ sent: 0, failed: 1 })
    // The whole point of the soft-fail: no ledger row, so the next run retries
    // this member instead of silently dropping them forever.
    expect(sqlCalls.some((c) => c.sql.includes('insert into feed_reminder_sends'))).toBe(
      false,
    )
  })
})
