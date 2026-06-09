// Unit tests for GET /api/admin/cancellations — the admin gate. The aggregation
// itself is plain SQL (verified manually against the DB); here we prove the
// route is admin-only and shaped correctly. No DATABASE_URL is set, so the
// handler returns empty aggregates for an admin (the DB-less branch).

import { describe, test, expect } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { silenceExpectedConsole } from './test-utils'

import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  // No DATABASE_URL on purpose → the handler returns empty aggregates.
}

const PATH = '/api/admin/cancellations'

function getHandler(path: string): Middleware {
  const handlers = new Map<string, Middleware>()
  const fakeServer = {
    middlewares: {
      use(p: string, handler: Middleware) {
        handlers.set(p, handler)
      },
    },
  }
  const plugin = devApiPlugin(BASE_ENV)
  ;(plugin.configureServer as unknown as (s: unknown) => void)(fakeServer)
  const h = handlers.get(path)
  if (!h) throw new Error(`handler not registered for ${path}`)
  return h
}

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as Omit<
    IncomingMessage,
    'socket'
  > & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = 'GET'
  stream.url = PATH
  stream.headers = headers
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

type FakeRes = ServerResponse & { __json: () => unknown }

function makeRes(): FakeRes {
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
    __json: () => JSON.parse(body) as unknown,
  } as unknown as FakeRes
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

async function get(headers?: Record<string, string>): Promise<FakeRes> {
  const res = makeRes()
  await runHandler(getHandler(PATH), makeReq(headers), res)
  return res
}

async function cookie(roles: string[]): Promise<string> {
  const token = await signSessionToken({ email: 'a@b.co', roles }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

silenceExpectedConsole()

describe('GET /api/admin/cancellations', () => {
  test('403 for an anonymous request', async () => {
    const res = await get()
    expect(res.statusCode).toBe(403)
  })

  test('403 for a logged-in non-admin', async () => {
    const res = await get({ cookie: await cookie([]) })
    expect(res.statusCode).toBe(403)
  })

  test('admin gets the summary shape (empty without a DB)', async () => {
    const res = await get({ cookie: await cookie(['admin']) })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ byOutcome: [], byReason: [], recent: [] })
  })
})
