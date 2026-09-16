// Wiring tests for the win-back cron and its unsubscribe endpoint.
//
// Drives both through the dev-api plugin with the Neon driver and outbound
// fetch (Resend) mocked, so the orchestrator runs end to end without a live DB
// or email. Mirrors feed-reminders-cron.test.ts.

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

// --- Neon mock -------------------------------------------------------------
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (merged) => nextSqlResult(merged)),
)

import { devApiPlugin } from './dev-api'
import { winbackUnsubToken } from './routes/winback'

const CRON_PATH = '/api/cron/winback'
const UNSUB_PATH = '/api/winback/unsubscribe'
const CRON_SECRET = 'cron-secret-abcdef0123456789'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  CRON_SECRET,
  RESEND_API_KEY: 'rk_test',
  DATABASE_URL: 'postgres://stub-winback-cron',
}

function envWithout(key: string): Record<string, string> {
  const copy = { ...BASE_ENV }
  delete copy[key]
  return copy
}

function getHandler(path: string, env = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(path)
}

function cronReq(opts: { method?: string; auth?: string } = {}) {
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
let resendStatus = 200

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  if (url.includes('api.resend.com')) {
    const ok = resendStatus >= 200 && resendStatus < 300
    return new Response(ok ? '{"id":"email_1"}' : '{"error":"boom"}', { status: resendStatus })
  }
  return new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()

type RosterRow = {
  email: string
  canceled_tier: string | null
  retained_product: string | null
  has_premium: boolean | null
  status: string | null
}

function leaver(over: Partial<RosterRow> = {}): RosterRow {
  return {
    email: 'left@example.com',
    canceled_tier: 'ark-plus',
    retained_product: 'full-exit',
    has_premium: false,
    status: 'active',
    ...over,
  }
}

function stageRun(opts: {
  roster?: RosterRow[]
  suppressed?: boolean
  alreadySent?: boolean
}) {
  nextSqlResult = (sql) => {
    if (sql.includes('from cancellation_survey')) return opts.roster ?? []
    if (sql.includes('from winback_suppression')) {
      return opts.suppressed ? [{ '?column?': 1 }] : []
    }
    if (sql.includes('from winback_sends')) {
      return opts.alreadySent ? [{ '?column?': 1 }] : []
    }
    return []
  }
}

function resendCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.url.includes('api.resend.com'))
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
describe('winback cron — guards', () => {
  test('405 on an unsupported method', async () => {
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq({ method: 'DELETE' }), res)
    expect(res.statusCode).toBe(405)
  })

  test('401 on a wrong secret, and nothing is sent', async () => {
    stageRun({ roster: [leaver()] })
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq({ auth: 'Bearer nope' }), res)
    expect(res.statusCode).toBe(401)
    expect(resendCalls()).toHaveLength(0)
  })

  test('500 when CRON_SECRET or DATABASE_URL is unset', async () => {
    for (const key of ['CRON_SECRET', 'DATABASE_URL']) {
      const res = makeRes()
      await runHandler(getHandler(CRON_PATH, envWithout(key)), cronReq(), res)
      expect(res.statusCode).toBe(500)
    }
  })
})

describe('winback cron — run', () => {
  test('an eligible leaver gets one email and one ledger row', async () => {
    stageRun({ roster: [leaver()] })
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq(), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ scanned: 1, eligible: 1, sent: 1, failed: 0 })

    const sends = resendCalls()
    expect(sends).toHaveLength(1)
    const body = parseJsonInitBody(sends[0]!.init) as Record<string, unknown>
    expect(body.to).toBe('left@example.com')
    expect(body.subject).toBe('We saved your seat')
    // The rejoin CTA and a real unsubscribe both have to be in there.
    expect(String(body.html)).toContain('https://ark.example/plus')
    expect(String(body.html)).toContain('/api/winback/unsubscribe?e=')

    expect(sqlCalls.some((c) => c.sql.includes('insert into winback_sends'))).toBe(true)
  })

  test('a suppressed address is skipped before the ledger is even read', async () => {
    stageRun({ roster: [leaver()], suppressed: true })
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq(), res)
    expect(res.__json()).toMatchObject({ eligible: 0, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
    expect(sqlCalls.some((c) => c.sql.includes('from winback_sends'))).toBe(false)
  })

  test('an address already mailed for this cohort is skipped', async () => {
    stageRun({ roster: [leaver()], alreadySent: true })
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq(), res)
    expect(res.__json()).toMatchObject({ eligible: 0, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
  })

  test('a member who came back is never invited back', async () => {
    stageRun({ roster: [leaver({ has_premium: true })] })
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq(), res)
    expect(res.__json()).toMatchObject({ scanned: 1, eligible: 0, sent: 0 })
    expect(resendCalls()).toHaveLength(0)
  })

  test('several cancellations for one address collapse to a single send', async () => {
    // Cancel, resubscribe, cancel again leaves two rows. The ledger would
    // collapse them after the first send; this collapses them before paying for
    // the lookups, and keeps `eligible` honest.
    stageRun({ roster: [leaver(), leaver({ canceled_tier: 'bundle' })] })
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq(), res)
    expect(res.__json()).toMatchObject({ scanned: 2, eligible: 1, sent: 1 })
    expect(resendCalls()).toHaveLength(1)
  })

  test('a send failure leaves the ledger untouched so the next run retries', async () => {
    stageRun({ roster: [leaver()] })
    resendStatus = 500
    const res = makeRes()
    await runHandler(getHandler(CRON_PATH), cronReq(), res)
    expect(res.__json()).toMatchObject({ eligible: 1, sent: 0, failed: 1 })
    expect(sqlCalls.some((c) => c.sql.includes('insert into winback_sends'))).toBe(false)
  })
})

// ===========================================================================
describe('winback unsubscribe', () => {
  const EMAIL = 'left@example.com'

  function unsubReq(query: string) {
    return makeFakeReq({ method: 'GET', url: `${UNSUB_PATH}?${query}` })
  }

  function validQuery(email = EMAIL): string {
    const e = Buffer.from(email, 'utf8').toString('base64url')
    return `e=${e}&t=${winbackUnsubToken(email, BASE_ENV)}`
  }

  test('a signed link suppresses the address', async () => {
    const res = makeRes()
    await runHandler(getHandler(UNSUB_PATH), unsubReq(validQuery()), res)
    expect(res.statusCode).toBe(200)
    const write = sqlCalls.find((c) => c.sql.includes('insert into winback_suppression'))
    expect(write).toBeDefined()
    expect(write!.values).toContain(EMAIL)
  })

  test('a forged token suppresses nothing', async () => {
    const e = Buffer.from('someone-else@example.com', 'utf8').toString('base64url')
    const res = makeRes()
    await runHandler(getHandler(UNSUB_PATH), unsubReq(`e=${e}&t=forged`), res)
    expect(res.statusCode).toBe(400)
    expect(sqlCalls.some((c) => c.sql.includes('insert into winback_suppression'))).toBe(
      false,
    )
  })

  test('a token for one address cannot opt out another', async () => {
    // Otherwise the endpoint is an unsubscribe oracle anyone can point at any
    // address they can guess.
    const other = Buffer.from('victim@example.com', 'utf8').toString('base64url')
    const res = makeRes()
    await runHandler(
      getHandler(UNSUB_PATH),
      unsubReq(`e=${other}&t=${winbackUnsubToken(EMAIL, BASE_ENV)}`),
      res,
    )
    expect(res.statusCode).toBe(400)
    expect(sqlCalls.some((c) => c.sql.includes('insert into winback_suppression'))).toBe(
      false,
    )
  })

  test('a missing token is refused', async () => {
    const res = makeRes()
    await runHandler(getHandler(UNSUB_PATH), unsubReq('e=&t='), res)
    expect(res.statusCode).toBe(400)
  })

  test('the address is normalized, so a link and the cron agree', async () => {
    const res = makeRes()
    await runHandler(getHandler(UNSUB_PATH), unsubReq(validQuery('  LEFT@Example.COM ')), res)
    expect(res.statusCode).toBe(200)
    const write = sqlCalls.find((c) => c.sql.includes('insert into winback_suppression'))
    expect(write!.values).toContain(EMAIL)
  })
})
