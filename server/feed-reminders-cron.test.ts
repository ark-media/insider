// Wiring tests for POST/GET /api/cron/feed-setup-reminders.
//
// Exercises the handler through the dev-api plugin with the Neon driver and
// outbound fetch (SC roster + Resend) mocked, so the full orchestrator runs
// without a live DB, SC, or email. Covers auth/config guards and the happy
// path: an in-window member with zero activations gets one reminder and a
// ledger row.

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

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  SC_NETWORK_ID: 'net_test',
  SC_API_KEY: 'sc_test',
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

// --- Outbound fetch mock (SC memberships list + Resend) --------------------
type FetchCall = { url: string; init?: RequestInit }
const originalFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []
let membershipsPayload: unknown = { data: [], current_page: 1, last_page: 1 }
// When set, /v1/memberships is served page-by-page from this map (keyed by the
// `page` query param) so multi-page pagination can be exercised. Otherwise the
// single `membershipsPayload` is returned for every page request.
let membershipsByPage: Record<number, unknown> | null = null
// Resend HTTP status — flip to a non-2xx to exercise the send-failure path.
let resendStatus = 200

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  if (url.includes('/v1/memberships')) {
    if (membershipsByPage) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      const payload = membershipsByPage[page] ?? {
        data: [],
        current_page: page,
        last_page: page,
      }
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    return new Response(JSON.stringify(membershipsPayload), { status: 200 })
  }
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

beforeEach(() => {
  sqlCalls.length = 0
  fetchCalls = []
  nextSqlResult = () => []
  membershipsPayload = { data: [], current_page: 1, last_page: 1 }
  membershipsByPage = null
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
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ enabled: true, scanned: 0, sent: 0 })
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('in-window member with zero activations → one reminder + ledger row', async () => {
    membershipsPayload = {
      current_page: 1,
      last_page: 1,
      data: [
        {
          id: 1,
          user_id: 1,
          email: 'Reader@X.com',
          first_name: 'Ada',
          status: 'active',
          joined: inWindowJoined(),
          feeds: [
            { id: 10, name: 'Show A', url: 'u' },
            { id: 20, name: 'Show B', url: 'u' },
          ],
        },
      ],
    }
    // Ledger check returns no row; activation read returns none.
    nextSqlResult = () => []

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ enabled: true, scanned: 1, eligible: 1, sent: 1, failed: 0 })

    // Resend called once, to the normalized address.
    const resend = fetchCalls.filter((c) => c.url.includes('resend'))
    expect(resend).toHaveLength(1)
    const sentBody = JSON.parse(resend[0]!.init?.body as string) as { to: string; subject: string }
    expect(sentBody.to).toBe('reader@x.com')
    expect(sentBody.subject).toContain('Finish setting up')

    // Ledger insert happened with the normalized email.
    const insert = sqlCalls.find((c) => c.sql.includes('insert into feed_reminder_sends'))
    expect(insert).toBeDefined()
    expect(insert!.values).toContain('reader@x.com')
  })

  test('member already in the ledger is skipped (no email)', async () => {
    membershipsPayload = {
      current_page: 1,
      last_page: 1,
      data: [
        {
          id: 2,
          user_id: 2,
          email: 'seen@x.com',
          status: 'active',
          joined: inWindowJoined(),
          feeds: [{ id: 10, name: 'Show A', url: 'u' }],
        },
      ],
    }
    // The ledger existence check returns a row → already reminded.
    nextSqlResult = (sql) =>
      sql.includes('from feed_reminder_sends') ? [{ '?column?': 1 }] : []

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ sent: 0 })
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
    expect(sqlCalls.some((c) => c.sql.includes('insert into feed_reminder_sends'))).toBe(false)
  })

  test('fully-activated member is skipped', async () => {
    membershipsPayload = {
      current_page: 1,
      last_page: 1,
      data: [
        {
          id: 3,
          user_id: 3,
          email: 'done@x.com',
          status: 'active',
          joined: inWindowJoined(),
          feeds: [
            { id: 10, name: 'Show A', url: 'u' },
            { id: 20, name: 'Show B', url: 'u' },
          ],
        },
      ],
    }
    // Ledger empty; activation read returns both feeds activated.
    nextSqlResult = (sql) => {
      if (sql.includes('from feed_reminder_sends')) return []
      if (sql.includes('from sc_feed_activations'))
        return [
          { feed_id: 10, activated_at: null },
          { feed_id: 20, activated_at: null },
        ]
      return []
    }

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ scanned: 1, eligible: 0, sent: 0 })
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('disabled config → short-circuits before touching the roster', async () => {
    const env = { ...BASE_ENV, FEED_REMINDER_ENABLED: 'false' }
    // A member who WOULD be reminded if enabled — proves the guard, not an
    // empty roster, is what stops the send.
    membershipsPayload = {
      current_page: 1,
      last_page: 1,
      data: [
        {
          id: 1,
          user_id: 1,
          email: 'a@x.com',
          status: 'active',
          joined: inWindowJoined(),
          feeds: [{ id: 10, name: 'Show A', url: 'u' }],
        },
      ],
    }

    const res = makeRes()
    await runHandler(buildHandler(env), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ enabled: false, sent: 0 })
    // No roster paging and no email when disabled.
    expect(fetchCalls.some((c) => c.url.includes('/v1/memberships'))).toBe(false)
    expect(fetchCalls.some((c) => c.url.includes('resend'))).toBe(false)
  })

  test('roster spanning two pages → a page-2 member still gets reminded', async () => {
    membershipsByPage = {
      1: {
        current_page: 1,
        last_page: 2,
        data: [
          {
            // Out of window → cheap-gated out (no DB read), proves paging goes on.
            id: 1,
            user_id: 1,
            email: 'old@x.com',
            status: 'active',
            joined: new Date(Date.now() - 60 * DAY).toISOString(),
            feeds: [{ id: 10, name: 'Show A', url: 'u' }],
          },
        ],
      },
      2: {
        current_page: 2,
        last_page: 2,
        data: [
          {
            id: 2,
            user_id: 2,
            email: 'page2@x.com',
            first_name: 'Bo',
            status: 'active',
            joined: inWindowJoined(),
            feeds: [{ id: 20, name: 'Show B', url: 'u' }],
          },
        ],
      },
    }
    nextSqlResult = () => [] // no prior sends, no activations

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ scanned: 2, eligible: 1, sent: 1 })

    const resend = fetchCalls.filter((c) => c.url.includes('resend'))
    expect(resend).toHaveLength(1)
    const sentBody = JSON.parse(resend[0]!.init?.body as string) as { to: string }
    expect(sentBody.to).toBe('page2@x.com')
    // Both roster pages were actually fetched.
    expect(fetchCalls.filter((c) => c.url.includes('/v1/memberships'))).toHaveLength(2)
  })

  test('Resend failure → counted as failed, ledger NOT written so it retries', async () => {
    resendStatus = 500
    membershipsPayload = {
      current_page: 1,
      last_page: 1,
      data: [
        {
          id: 1,
          user_id: 1,
          email: 'fail@x.com',
          first_name: 'Ada',
          status: 'active',
          joined: inWindowJoined(),
          feeds: [{ id: 10, name: 'Show A', url: 'u' }],
        },
      ],
    }
    nextSqlResult = () => []

    const res = makeRes()
    await runHandler(buildHandler(), makeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ sent: 0, failed: 1 })
    // The whole point of the soft-fail: no ledger row, so the next run retries
    // this member instead of silently dropping them forever.
    expect(sqlCalls.some((c) => c.sql.includes('insert into feed_reminder_sends'))).toBe(false)
  })
})
