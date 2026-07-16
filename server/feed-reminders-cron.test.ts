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
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { silenceExpectedConsole } from './test-utils'

// --- Neon mock -------------------------------------------------------------
type SqlCall = { sql: string; values: unknown[] }
const sqlCalls: SqlCall[] = []
let nextSqlResult: (sql: string) => unknown[] = () => []

mock.module('@neondatabase/serverless', () => ({
  neon: (_url: string) =>
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const merged = strings.join('?')
      sqlCalls.push({ sql: merged, values })
      return Promise.resolve(nextSqlResult(merged))
    }) as unknown,
  __esModule: true,
}))

import { devApiPlugin } from './dev-api'

// --- Plugin harness --------------------------------------------------------
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

const CRON_PATH = '/api/cron/feed-setup-reminders'
const CRON_SECRET = 'cron-secret-abcdef0123456789'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  SC_NETWORK_ID: 'net_test',
  SC_API_KEY: 'sc_test',
  CRON_SECRET,
  RESEND_API_KEY: 'rk_test',
  DATABASE_URL: 'postgres://stub-feed-reminders-cron',
}

function envWithout(key: string): Record<string, string> {
  const copy = { ...BASE_ENV }
  delete copy[key]
  return copy
}

function buildHandler(env: Record<string, string> = BASE_ENV): Middleware {
  const handlers = new Map<string, Middleware>()
  const fakeServer = {
    middlewares: {
      use(path: string, handler: Middleware) {
        handlers.set(path, handler)
      },
    },
  }
  const plugin = devApiPlugin(env)
  ;(plugin.configureServer as unknown as (s: unknown) => void)(fakeServer)
  const handler = handlers.get(CRON_PATH)
  if (!handler) throw new Error(`handler not registered for ${CRON_PATH}`)
  return handler
}

// --- Fake req/res ----------------------------------------------------------
function makeReq(opts: { method?: string; auth?: string } = {}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as Omit<
    IncomingMessage,
    'socket'
  > & { method?: string; url?: string; headers: Record<string, string>; socket: { remoteAddress: string } }
  stream.method = opts.method ?? 'POST'
  stream.url = CRON_PATH
  stream.headers = {}
  if (opts.auth !== undefined) stream.headers.authorization = opts.auth
  else stream.headers.authorization = `Bearer ${CRON_SECRET}`
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

type FakeRes = ServerResponse & { __json: () => unknown }
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
  } as unknown as FakeRes
  return res
}

function runHandler(handler: Middleware, req: IncomingMessage, res: FakeRes) {
  return new Promise<void>((resolve, reject) => {
    const origEnd = res.end.bind(res)
    ;(res as unknown as { end: typeof origEnd }).end = ((chunk?: string | Buffer) => {
      origEnd(chunk as string | Buffer)
      resolve()
      return res
    }) as typeof origEnd
    try {
      handler(req, res as ServerResponse, (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// --- Outbound fetch mock (SC memberships list + Resend) --------------------
type FetchCall = { url: string; init?: RequestInit }
const originalFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []
let membershipsPayload: unknown = { data: [], current_page: 1, last_page: 1 }

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  if (url.includes('/v1/memberships')) {
    return new Response(JSON.stringify(membershipsPayload), { status: 200 })
  }
  if (url.includes('api.resend.com')) {
    return new Response('{"id":"email_1"}', { status: 200 })
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
})
