// Unit tests for the /api/sc/send-setup-sms endpoint.
//
// Strategy: build the plugin with a stub `server.middlewares.use` that captures
// registered handlers, then invoke the SMS handler directly with a fake
// IncomingMessage (a Readable over a JSON body) and a minimal ServerResponse.
// `fetch` is monkey-patched per test so the SC calls never leave the process.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { devApiPlugin } from './dev-api'

const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
const SESSION_COOKIE = 'insider_session'
const SMS_PATH = '/api/sc/send-setup-sms'

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

// --- Token helpers (mirror the plugin's HMAC format) -----------------------
function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function signToken<T>(secret: string, payload: T): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const mac = crypto.createHmac('sha256', secret).update(body).digest()
  return `${body}.${b64url(mac)}`
}

function sessionCookie(scUserId = 42): string {
  const token = signToken(SESSION_SECRET, {
    email: 'user@example.com',
    sc_user_id: scUserId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`
}

// --- Plugin harness --------------------------------------------------------
function buildSmsHandler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const fakeServer = {
    middlewares: {
      use(path: string, handler: Middleware) {
        handlers.set(path, handler)
      },
    },
  }
  const plugin = devApiPlugin({
    SESSION_SECRET,
    SC_NETWORK_ID: 'test-net',
    SC_API_KEY: 'test-key',
    APP_BASE_URL: 'http://localhost:5173',
  })
  const configure = plugin.configureServer as unknown as (s: unknown) => void
  configure(fakeServer)
  const handler = handlers.get(SMS_PATH)
  if (!handler) throw new Error(`handler not registered for ${SMS_PATH}`)
  return handler
}

// --- Fake req/res ----------------------------------------------------------
type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __header: (name: string) => string | undefined
}

function makeReq(opts: {
  method?: string
  body?: unknown
  cookie?: string
}): IncomingMessage {
  const raw =
    opts.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(opts.body), 'utf8')
  const stream = Readable.from([raw]) as unknown as IncomingMessage & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'POST'
  stream.url = SMS_PATH
  stream.headers = opts.cookie ? { cookie: opts.cookie } : {}
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as IncomingMessage
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {}
  let body = ''
  let statusCode = 200
  let ended = false
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
    __body: () => body,
    __json: () => JSON.parse(body) as unknown,
    __header: (name: string) => headers[name.toLowerCase()],
  } as unknown as FakeRes
  return res
}

function runHandler(handler: Middleware, req: IncomingMessage, res: FakeRes) {
  return new Promise<void>((resolve, reject) => {
    const origEnd = res.end.bind(res)
    ;(res as unknown as { end: typeof origEnd }).end = (chunk?: string | Buffer) => {
      origEnd(chunk as string | Buffer)
      resolve()
      return res
    }
    try {
      handler(req, res as ServerResponse, (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// --- Fetch mock ------------------------------------------------------------
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []
let fetchImpl: FetchImpl = async () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  let parsed: unknown = undefined
  if (init?.body && typeof init.body === 'string') {
    try {
      parsed = JSON.parse(init.body)
    } catch {
      parsed = init.body
    }
  }
  fetchCalls.push({ url, method: init?.method ?? 'GET', body: parsed })
  return fetchImpl(url, init)
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  fetchCalls.length = 0
  fetchImpl = async () => new Response('{}', { status: 200 })
})

// ===========================================================================
// Tests
// ===========================================================================

describe('POST /api/sc/send-setup-sms — auth gate', () => {
  test('401 when no session cookie', async () => {
    const handler = buildSmsHandler()
    const req = makeReq({ body: { phone: '5551234567', feed_id: 1 } })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(401)
    expect(res.__json()).toEqual({ error: 'unauthenticated' })
    expect(fetchCalls).toHaveLength(0)
  })

  test('401 when session cookie is malformed', async () => {
    const handler = buildSmsHandler()
    const req = makeReq({
      body: { phone: '5551234567', feed_id: 1 },
      cookie: `${SESSION_COOKIE}=not-a-real-token`,
    })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(401)
    expect(fetchCalls).toHaveLength(0)
  })

  test('401 when session is signed with a different secret', async () => {
    const handler = buildSmsHandler()
    const forged = signToken('wrong-secret', {
      email: 'user@example.com',
      sc_user_id: 42,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const req = makeReq({
      body: { phone: '5551234567', feed_id: 1 },
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}`,
    })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(401)
  })

  test('405 on non-POST', async () => {
    const handler = buildSmsHandler()
    const req = makeReq({ method: 'GET', cookie: sessionCookie() })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(405)
  })
})

describe('POST /api/sc/send-setup-sms — rate limit', () => {
  test('allows 3 requests then 429s with retry-after header', async () => {
    const handler = buildSmsHandler()
    const cookie = sessionCookie()

    for (let i = 0; i < 3; i++) {
      const req = makeReq({ body: { phone: '5551234567', feed_id: 1 }, cookie })
      const res = makeRes()
      await runHandler(handler, req, res)
      expect(res.statusCode).toBe(200)
    }

    const req = makeReq({ body: { phone: '5551234567', feed_id: 1 }, cookie })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(429)
    const retry = res.__header('retry-after')
    expect(retry).toBeDefined()
    expect(Number(retry)).toBeGreaterThan(0)
    const body = res.__json() as { error: string }
    expect(body.error).toMatch(/too many/i)
  })

  test('rate limit is per sc_user_id — a different user is not blocked', async () => {
    const handler = buildSmsHandler()

    for (let i = 0; i < 3; i++) {
      const req = makeReq({
        body: { phone: '5551234567', feed_id: 1 },
        cookie: sessionCookie(1),
      })
      const res = makeRes()
      await runHandler(handler, req, res)
      expect(res.statusCode).toBe(200)
    }

    const req = makeReq({
      body: { phone: '5551234567', feed_id: 1 },
      cookie: sessionCookie(2),
    })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/sc/send-setup-sms — phone normalization', () => {
  async function sendPhone(phone: unknown): Promise<{
    status: number
    json: unknown
    sentPhone: string | undefined
  }> {
    const handler = buildSmsHandler()
    const req = makeReq({
      body: { phone, feed_id: 1 },
      cookie: sessionCookie(Math.floor(Math.random() * 1e9)),
    })
    const res = makeRes()
    await runHandler(handler, req, res)
    const smsCall = fetchCalls.find((c) => c.url.endsWith('/send_setup_sms'))
    const sentPhone =
      smsCall && typeof smsCall.body === 'object' && smsCall.body !== null
        ? (smsCall.body as { phone?: string }).phone
        : undefined
    return {
      status: res.statusCode,
      json: res.__body() ? res.__json() : null,
      sentPhone,
    }
  }

  test('bare 10-digit US number → +1XXXXXXXXXX', async () => {
    const r = await sendPhone('5551234567')
    expect(r.status).toBe(200)
    expect(r.sentPhone).toBe('+15551234567')
  })

  test('already-E.164 +1XXXXXXXXXX passes through unchanged', async () => {
    const r = await sendPhone('+15551234567')
    expect(r.status).toBe(200)
    expect(r.sentPhone).toBe('+15551234567')
  })

  test('11-digit with leading 1 (no +) → prepends + only', async () => {
    const r = await sendPhone('15551234567')
    expect(r.status).toBe(200)
    expect(r.sentPhone).toBe('+15551234567')
  })

  test('"++1" (too few digits) → 400', async () => {
    const r = await sendPhone('++1')
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toMatch(/valid phone number/i)
  })

  test('empty string → 400 "Phone number is required"', async () => {
    const r = await sendPhone('')
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toMatch(/required/i)
  })

  test('whitespace-only string → 400 "Phone number is required"', async () => {
    const r = await sendPhone('   ')
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toMatch(/required/i)
  })

  test('non-string (number) → 400, no SC call made', async () => {
    const r = await sendPhone(5551234567)
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toMatch(/required/i)
    expect(r.sentPhone).toBeUndefined()
  })

  test('non-string (null) → 400, no SC call made', async () => {
    const r = await sendPhone(null)
    expect(r.status).toBe(400)
    expect(r.sentPhone).toBeUndefined()
  })
})

describe('POST /api/sc/send-setup-sms — SC error surfacing', () => {
  test('SC 422 → 422 with user-friendly format error', async () => {
    const handler = buildSmsHandler()
    fetchImpl = async (url) => {
      if (url.endsWith('/send_setup_sms')) {
        return new Response(JSON.stringify({ error: 'unroutable' }), {
          status: 422,
        })
      }
      return new Response('{}', { status: 200 })
    }
    const req = makeReq({
      body: { phone: '+15551234567', feed_id: 1 },
      cookie: sessionCookie(),
    })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(422)
    expect((res.__json() as { error: string }).error).toMatch(/format/i)
  })

  test('SC 429 → 429 with rate-limit message', async () => {
    const handler = buildSmsHandler()
    fetchImpl = async (url) => {
      if (url.endsWith('/send_setup_sms')) {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
        })
      }
      return new Response('{}', { status: 200 })
    }
    const req = makeReq({
      body: { phone: '+15551234567', feed_id: 1 },
      cookie: sessionCookie(),
    })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(429)
    expect((res.__json() as { error: string }).error).toMatch(/rate limit/i)
  })

  test('SC 500 → falls through to generic 500 with generic message', async () => {
    const handler = buildSmsHandler()
    fetchImpl = async (url) => {
      if (url.endsWith('/send_setup_sms')) {
        return new Response('{}', { status: 500 })
      }
      return new Response('{}', { status: 200 })
    }
    const req = makeReq({
      body: { phone: '+15551234567', feed_id: 1 },
      cookie: sessionCookie(),
    })
    const res = makeRes()
    await runHandler(handler, req, res)
    expect(res.statusCode).toBe(500)
    expect((res.__json() as { error: string }).error).toMatch(/could not send/i)
  })
})
