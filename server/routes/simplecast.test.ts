// Tests for GET /api/simplecast/podcast. Wires `simplecastRoutes()` with a
// minimal Deps bundle and exercises the handler with fake req/res, monkey-
// patching `fetch` per test so no real Simplecast calls leave the process.
//
// Covers: method gating, slug-shape allowlist, missing-config shortcut to
// empty 200, HTML stripping on the happy path, in-process cache hit, and
// upstream-error → 502.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { simplecastRoutes } from './simplecast.js'
import type { Deps } from '../lib/route.js'
import { silenceExpectedConsole } from '../test-utils.js'

const PATH = '/api/simplecast/podcast'

// --- Fake req/res ----------------------------------------------------------
type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __status: () => number
}

function makeReq(path: string, query: string): IncomingMessage {
  const url = query ? `${path}?${query}` : path
  return {
    method: 'GET',
    url,
    headers: {},
  } as unknown as IncomingMessage
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

function findHandler(deps: Deps) {
  const route = simplecastRoutes(deps).find((r) => r.path === PATH)
  if (!route) throw new Error(`route ${PATH} not registered`)
  return route.handler
}

// --- Fetch mock ------------------------------------------------------------
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string }> = []
let fetchImpl: FetchImpl = async () => new Response('{}', { status: 200 })

globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url })
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

describe('GET /api/simplecast/podcast — input validation', () => {
  test('rejects non-GET methods with 405', async () => {
    const handler = findHandler(buildDeps())
    const req = makeReq(PATH, 'show=call-me-back')
    ;(req as { method: string }).method = 'POST'
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(405)
  })

  test('rejects missing `show` param with 400', async () => {
    const handler = findHandler(buildDeps())
    const req = makeReq(PATH, '')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(400)
    expect(res.__json()).toEqual({ error: 'missing `show`' })
  })

  test('returns empty 200 for slugs that fail the allowlist regex', async () => {
    // resolveSimplecastPodcastId enforces /^[a-z0-9-]+$/ so the env-key lookup
    // can't be probed with arbitrary characters. Anything outside that shape
    // falls through to the "no binding" empty response.
    const handler = findHandler(
      buildDeps({
        SIMPLECAST_API_TOKEN: 't',
        VITE_SIMPLECAST_PODCAST_ID_CALL_ME_BACK: 'pod-1',
      }),
    )
    const req = makeReq(PATH, 'show=Call%20Me%20Back')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ description: '' })
    expect(fetchCalls.length).toBe(0)
  })
})

describe('GET /api/simplecast/podcast — binding / token shortcuts', () => {
  test('returns empty 200 when the show has no podcast id configured', async () => {
    const handler = findHandler(buildDeps({ SIMPLECAST_API_TOKEN: 't' }))
    const req = makeReq(PATH, 'show=call-me-back')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ description: '' })
    expect(fetchCalls.length).toBe(0)
  })

  test('returns empty 200 when the Simplecast token is unset', async () => {
    const handler = findHandler(
      buildDeps({ VITE_SIMPLECAST_PODCAST_ID_CALL_ME_BACK: 'pod-1' }),
    )
    const req = makeReq(PATH, 'show=call-me-back')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ description: '' })
    expect(fetchCalls.length).toBe(0)
  })
})

describe('GET /api/simplecast/podcast — upstream behavior', () => {
  // Use a fresh slug per test so each test gets a cold cache (the module-
  // level Map is keyed by podcastId).
  function envFor(podcastId: string, slugSuffix: string) {
    return {
      SIMPLECAST_API_TOKEN: 't',
      [`VITE_SIMPLECAST_PODCAST_ID_TEST_${slugSuffix}`]: podcastId,
    }
  }

  test('strips HTML from the upstream description on the happy path', async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          description: '<p>A <strong>serious</strong> conversation</p>',
        }),
        { status: 200 },
      )
    const handler = findHandler(buildDeps(envFor('pod-happy', 'HAPPY')))
    const req = makeReq(PATH, 'show=test-happy')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    // stripHtml replaces tags with spaces and collapses runs of whitespace;
    // we assert on text content rather than exact whitespace formatting.
    const body = res.__json() as { description: string }
    expect(body.description).not.toContain('<')
    expect(body.description).toContain('serious')
    expect(body.description).toContain('A')
    expect(body.description).toContain('conversation')
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]!.url).toContain('/podcasts/pod-happy')
  })

  test('a second request inside the TTL hits the cache (no second upstream call)', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ description: 'cached' }), { status: 200 })
    const handler = findHandler(buildDeps(envFor('pod-cache', 'CACHE')))

    const res1 = makeRes()
    await handler(makeReq(PATH, 'show=test-cache'), res1)
    expect(res1.__status()).toBe(200)
    expect(fetchCalls.length).toBe(1)

    const res2 = makeRes()
    await handler(makeReq(PATH, 'show=test-cache'), res2)
    expect(res2.__status()).toBe(200)
    expect(res2.__json()).toEqual({ description: 'cached' })
    // Still only one upstream call.
    expect(fetchCalls.length).toBe(1)
  })

  test('maps an upstream 5xx to a 502', async () => {
    fetchImpl = async () => new Response('boom', { status: 503 })
    const handler = findHandler(buildDeps(envFor('pod-err', 'ERR')))
    const req = makeReq(PATH, 'show=test-err')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(502)
    expect(res.__json()).toEqual({ error: 'simplecast_unavailable' })
  })

  test('treats a missing upstream description as empty string', async () => {
    fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 })
    const handler = findHandler(buildDeps(envFor('pod-empty', 'EMPTY')))
    const req = makeReq(PATH, 'show=test-empty')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ description: '' })
  })
})
