// Tests for the /api/beehiiv/subscribe route. Wires `beehiivRoutes()` with a
// minimal Deps bundle and exercises the handler with fake req/res, monkey-
// patching `fetch` per test so no real Beehiiv calls leave the process.
//
// Covers input validation, missing-config shortcuts, rate limiting, upstream
// error mapping (generic vs. already-subscribed), and the happy path —
// including assertions on the upstream URL and request body so a Beehiiv API
// shape change won't silently regress.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beehiivRoutes } from './beehiiv.js'
import type { Deps } from '../lib/route.js'
import { silenceExpectedConsole } from '../test-utils.js'

const SUBSCRIBE_PATH = '/api/beehiiv/subscribe'

const VALID_ENV = {
  BEEHIIV_API_KEY: 'test-key',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_test-1234',
}

// --- Fake req/res ----------------------------------------------------------
type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __header: (name: string) => string | undefined
  __status: () => number
}

function makeReq(
  path: string,
  body: unknown,
  opts: { method?: string; clientIp?: string } = {},
): IncomingMessage {
  const json = body === undefined ? '' : JSON.stringify(body)
  const chunks = json ? [Buffer.from(json)] : []
  let i = 0
  const stream = {
    method: opts.method ?? 'POST',
    url: path,
    headers: opts.clientIp ? { 'x-forwarded-for': opts.clientIp } : {},
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (i < chunks.length) {
            return Promise.resolve({ value: chunks[i++], done: false })
          }
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
  return stream as unknown as IncomingMessage
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
    __status: () => statusCode,
  } as unknown as FakeRes
  return res
}

function buildDeps(env: Record<string, string> = {}): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: 'http://localhost:5173',
    activator: {} as Deps['activator'],
  }
}

function findHandler(deps: Deps, path: string) {
  const route = beehiivRoutes(deps).find((r) => r.path === path)
  if (!route) throw new Error(`route ${path} not registered`)
  return route.handler
}

// --- Fetch mock ------------------------------------------------------------
type FetchCall = { url: string; init?: RequestInit }
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const originalFetch = globalThis.fetch
const fetchCalls: FetchCall[] = []
let fetchImpl: FetchImpl = async () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  return fetchImpl(url, init)
}) as typeof fetch

silenceExpectedConsole()

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  fetchCalls.length = 0
  fetchImpl = async () => new Response('{}', { status: 200 })
})

// --- Tests -----------------------------------------------------------------

describe('POST /api/beehiiv/subscribe — input validation', () => {
  test('rejects non-POST with 405', async () => {
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, undefined, { method: 'GET' })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(405)
    expect(fetchCalls.length).toBe(0)
  })

  test('rejects missing newsletter with 400', async () => {
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, { email: 'a@b.co' })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(400)
    expect(res.__json()).toEqual({ error: 'invalid `newsletter`' })
    expect(fetchCalls.length).toBe(0)
  })

  test('rejects unknown newsletter slug with 400', async () => {
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'not-a-real-slug',
      email: 'a@b.co',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(400)
    expect(res.__json()).toEqual({ error: 'invalid `newsletter`' })
    expect(fetchCalls.length).toBe(0)
  })

  test('rejects malformed email with 400', async () => {
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: 'not-an-email',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(400)
    expect(res.__json()).toEqual({ error: 'invalid_email' })
    expect(fetchCalls.length).toBe(0)
  })
})

describe('POST /api/beehiiv/subscribe — config shortcuts', () => {
  test('returns 503 when BEEHIIV_API_KEY is unset', async () => {
    const handler = findHandler(
      buildDeps({ BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_x' }),
      SUBSCRIBE_PATH,
    )
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: 'a@b.co',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(503)
    expect(res.__json()).toEqual({ error: 'beehiiv_not_configured' })
    expect(fetchCalls.length).toBe(0)
  })

  test('returns 503 when the publication-id env var is unset', async () => {
    const handler = findHandler(
      buildDeps({ BEEHIIV_API_KEY: 'test-key' }),
      SUBSCRIBE_PATH,
    )
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: 'a@b.co',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(503)
    expect(fetchCalls.length).toBe(0)
  })
})

describe('POST /api/beehiiv/subscribe — happy path', () => {
  test('calls Beehiiv v2 with the right URL, headers, and body', async () => {
    fetchImpl = async () => new Response('{"data":{"id":"sub_1"}}', { status: 201 })
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: '  reader@example.com  ',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ ok: true })
    expect(fetchCalls.length).toBe(1)

    const call = fetchCalls[0]!
    expect(call.url).toBe(
      'https://api.beehiiv.com/v2/publications/pub_test-1234/subscriptions',
    )
    expect(call.init?.method).toBe('POST')

    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(call.init?.body as string) as Record<string, unknown>
    expect(body.email).toBe('reader@example.com') // trimmed
    expect(body.reactivate_existing).toBe(true)
    expect(body.utm_source).toBe('insider-site')
  })
})

describe('POST /api/beehiiv/subscribe — upstream error mapping', () => {
  test('maps generic upstream 4xx to 400 subscribe_rejected', async () => {
    fetchImpl = async () =>
      new Response('{"errors":[{"detail":"Email blocked"}]}', { status: 400 })
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: 'a@b.co',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(400)
    expect(res.__json()).toEqual({ error: 'subscribe_rejected' })
  })

  test('detects already-subscribed in the upstream body and returns 409', async () => {
    fetchImpl = async () =>
      new Response('{"errors":[{"detail":"Email already subscribed"}]}', {
        status: 400,
      })
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: 'a@b.co',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(409)
    expect(res.__json()).toEqual({ error: 'already_subscribed' })
  })

  test('maps upstream 5xx to 502 beehiiv_unavailable', async () => {
    fetchImpl = async () => new Response('upstream boom', { status: 503 })
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: 'a@b.co',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(502)
    expect(res.__json()).toEqual({ error: 'beehiiv_unavailable' })
  })

  test('maps fetch throwing to 502 beehiiv_unavailable', async () => {
    fetchImpl = async () => {
      throw new Error('network down')
    }
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)
    const req = makeReq(SUBSCRIBE_PATH, {
      newsletter: 'ark-daily',
      email: 'a@b.co',
    })
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(502)
  })
})

describe('POST /api/beehiiv/subscribe — rate limiting', () => {
  test('returns 429 with retry-after after burst is exhausted', async () => {
    fetchImpl = async () => new Response('{}', { status: 201 })
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)

    // Capacity is 10. The 11th request from the same IP should be limited.
    for (let i = 0; i < 10; i++) {
      const req = makeReq(
        SUBSCRIBE_PATH,
        { newsletter: 'ark-daily', email: `r${i}@b.co` },
        { clientIp: '203.0.113.7' },
      )
      const res = makeRes()
      await handler(req, res)
      expect(res.__status()).toBe(200)
    }

    const blockedReq = makeReq(
      SUBSCRIBE_PATH,
      { newsletter: 'ark-daily', email: 'r11@b.co' },
      { clientIp: '203.0.113.7' },
    )
    const blockedRes = makeRes()
    await handler(blockedReq, blockedRes)
    expect(blockedRes.__status()).toBe(429)
    expect(blockedRes.__json()).toEqual({ error: 'too_many_requests' })
    expect(blockedRes.__header('retry-after')).toBeDefined()
  })

  test('different client IPs have independent buckets', async () => {
    fetchImpl = async () => new Response('{}', { status: 201 })
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)

    // Drain IP A's bucket.
    for (let i = 0; i < 10; i++) {
      const req = makeReq(
        SUBSCRIBE_PATH,
        { newsletter: 'ark-daily', email: `a${i}@b.co` },
        { clientIp: '198.51.100.1' },
      )
      await handler(req, makeRes())
    }

    // IP B should still get through.
    const reqB = makeReq(
      SUBSCRIBE_PATH,
      { newsletter: 'ark-daily', email: 'b@b.co' },
      { clientIp: '198.51.100.2' },
    )
    const resB = makeRes()
    await handler(reqB, resB)
    expect(resB.__status()).toBe(200)
  })

  test('reads the leftmost IP from x-forwarded-for', async () => {
    fetchImpl = async () => new Response('{}', { status: 201 })
    const handler = findHandler(buildDeps(VALID_ENV), SUBSCRIBE_PATH)

    // Drain the bucket for client "192.0.2.5" (leftmost of an xff chain).
    for (let i = 0; i < 10; i++) {
      const req = makeReq(
        SUBSCRIBE_PATH,
        { newsletter: 'ark-daily', email: `x${i}@b.co` },
        { clientIp: '192.0.2.5, 10.0.0.1, 10.0.0.2' },
      )
      await handler(req, makeRes())
    }

    // A different request whose xff *also* starts with 192.0.2.5 should hit
    // the same bucket and be limited.
    const req = makeReq(
      SUBSCRIBE_PATH,
      { newsletter: 'ark-daily', email: 'x99@b.co' },
      { clientIp: '192.0.2.5, 10.0.0.99' },
    )
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(429)
  })
})
