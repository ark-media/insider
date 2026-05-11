// Regression tests for createCatchAllHandler — the Vercel Function entry
// point at api/handler.ts.
//
// Background: vercel.json rewrites `/api/(.*)` to `/api/handler?_path=$1`,
// so every request that reaches this handler in production carries the
// original path in the `_path` query param. The handler must dispatch on
// that param, fall back to req.url for non-rewritten callers (dev server,
// tests that hit the handler directly), and not corrupt the inner
// handler's own query params (`show`, `id`, etc.).

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createCatchAllHandler } from './dev-api'

type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __header: (name: string) => string | undefined
}

function makeReq(opts: { method?: string; url: string }): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(0)]) as unknown as Omit<
    IncomingMessage,
    'socket'
  > & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'GET'
  stream.url = opts.url
  stream.headers = {}
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {}
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
}

function buildHandler() {
  return createCatchAllHandler({
    SC_NETWORK_ID: 'test-net',
    SC_API_KEY: 'test-key',
    APP_BASE_URL: 'http://localhost:5173',
    SIMPLECAST_API_TOKEN: 'test-token',
    VITE_SIMPLECAST_PODCAST_ID_CALL_ME_BACK: 'pod-cmb',
  })
}

// --- Fetch mock ------------------------------------------------------------
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; method: string }> = []
let fetchImpl: FetchImpl = async () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
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

describe('createCatchAllHandler — dispatch via _path query param', () => {
  test('multi-segment _path routes to the matching handler (regression: /api/simplecast/episodes returned NOT_FOUND under [...slug])', async () => {
    fetchImpl = async (url) => {
      if (url.startsWith('https://api.simplecast.com/podcasts/')) {
        return new Response(
          JSON.stringify({
            collection: [
              {
                id: 'ep-1',
                slug: 'episode-one',
                title: 'Episode One',
                description: 'desc',
                duration: 1800,
                published_at: '2026-05-01T00:00:00Z',
                is_published: true,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }

    const handler = buildHandler()
    const req = makeReq({
      url: '/api/handler?_path=simplecast/episodes&show=call-me-back',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.__json() as { episodes: Array<{ slug: string }> }
    expect(body.episodes).toHaveLength(1)
    expect(body.episodes[0].slug).toBe('episode-one')
  })

  test('inner handler still reads its own query params when _path is present', async () => {
    const handler = buildHandler()
    // Missing `show` should return 400 — proves the inner handler is parsing
    // searchParams and that _path coexists with real params without confusing it.
    const req = makeReq({ url: '/api/handler?_path=simplecast/episodes' })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/show/)
  })

  test('single-segment _path also routes correctly', async () => {
    const handler = buildHandler()
    // /api/me requires a session and returns 401 — that proves the handler was
    // found and invoked.
    const req = makeReq({ url: '/api/handler?_path=me' })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(401)
    expect((res.__json() as { error: string }).error).toBe('unauthenticated')
  })

  test('unknown _path returns the catch-all JSON 404', async () => {
    const handler = buildHandler()
    const req = makeReq({ url: '/api/handler?_path=nope/does-not-exist' })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(404)
    expect(res.__json()).toEqual({
      error: 'not_found',
      path: '/api/nope/does-not-exist',
    })
  })
})

describe('createCatchAllHandler — fallback to url.pathname', () => {
  test('no _path → dispatches by req.url pathname (dev server / direct invocation)', async () => {
    const handler = buildHandler()
    const req = makeReq({ url: '/api/me' })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(401)
    expect((res.__json() as { error: string }).error).toBe('unauthenticated')
  })

  test('no _path on multi-segment pathname also works', async () => {
    // No matching podcast id env → handler short-circuits to {episodes:[]}.
    // We can't rely on the fetch mock here because the simplecast handler
    // caches per-podcast-id in module scope.
    const handler = createCatchAllHandler({
      SC_NETWORK_ID: 'test-net',
      SC_API_KEY: 'test-key',
      APP_BASE_URL: 'http://localhost:5173',
    })
    const req = makeReq({
      url: '/api/simplecast/episodes?show=unknown-show',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ episodes: [] })
  })

  test('unknown pathname (no _path) returns JSON 404 with the original path', async () => {
    const handler = buildHandler()
    const req = makeReq({ url: '/api/bogus' })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(404)
    expect(res.__json()).toEqual({ error: 'not_found', path: '/api/bogus' })
  })
})
