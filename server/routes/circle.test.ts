// Tests for the /api/circle/space-posts route. Wires `circleRoutes()` with a
// minimal Deps bundle and exercises the handler with fake req/res, monkey-
// patching `fetch` per test so no real Circle calls leave the process.
//
// Covers the pagination loop, missing-token / missing-binding shortcuts,
// upstream error mapping, and the space-id → posts walk. The projection
// itself is covered by circle-space-posts.test.ts.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { __resetCircleCachesForTests, circleRoutes } from './circle.js'
import type { Deps } from '../lib/route.js'
import { silenceExpectedConsole } from '../test-utils.js'

const SPACE_POSTS_PATH = '/api/circle/space-posts'
const BROADCASTS_PATH = '/api/circle/broadcasts'

// --- Fake req/res ----------------------------------------------------------
type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __header: (name: string) => string | undefined
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
  const route = circleRoutes(deps).find((r) => r.path === path)
  if (!route) throw new Error(`route ${path} not registered`)
  return route.handler
}

// --- Fetch mock ------------------------------------------------------------
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const originalFetch = globalThis.fetch
const fetchCalls: Array<{ url: string }> = []
let fetchImpl: FetchImpl = async () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
  __resetCircleCachesForTests()
})

// --- Tests -----------------------------------------------------------------

describe('GET /api/circle/space-posts — input validation', () => {
  test('rejects missing newsletter param with 400', async () => {
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, '')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(400)
    expect(res.__json()).toEqual({ error: 'missing `newsletter`' })
  })

  test('rejects unknown newsletter slug with 400', async () => {
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=not-a-real-slug')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(400)
    expect(res.__json()).toEqual({ error: 'invalid `newsletter`' })
  })

  test('rejects non-GET methods with 405', async () => {
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    ;(req as { method: string }).method = 'POST'
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(405)
  })
})

describe('GET /api/circle/space-posts — token / binding shortcuts', () => {
  test('returns empty list when CIRCLE_ADMIN_API_TOKEN is unset', async () => {
    const handler = findHandler(buildDeps({}), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ posts: [] })
    expect(fetchCalls.length).toBe(0) // no upstream call attempted
  })

  test('returns empty list when newsletter has no space binding', async () => {
    // ark-daily is a valid slug but isn't bound to a Circle space.
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=ark-daily')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ posts: [] })
    expect(fetchCalls.length).toBe(0)
  })

  test('sets SWR cache-control on success path', async () => {
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 7, slug: 'ark-code-of-conduct' }] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ records: [] }), { status: 200 })
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__header('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=3600',
    )
  })
})

describe('GET /api/circle/space-posts — upstream behavior', () => {
  test('returns empty list when the configured space slug is not found', async () => {
    // The /spaces endpoint returns pages that don't contain ark-code-of-conduct.
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 1, slug: 'general' }] }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ posts: [] })
    // Should have called /spaces but never reached /posts
    expect(fetchCalls.some((c) => c.url.includes('/posts'))).toBe(false)
  })

  test('maps upstream 5xx to a 502 with a stable error code', async () => {
    fetchImpl = async () =>
      new Response('upstream down', { status: 500 })
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(502)
    expect(res.__json()).toEqual({ error: 'circle_unavailable' })
  })

  test('projects posts and returns them sorted by publishedAt desc', async () => {
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 9, slug: 'ark-code-of-conduct' }] }),
          { status: 200 },
        )
      }
      if (url.includes('/posts')) {
        return new Response(
          JSON.stringify({
            records: [
              {
                id: 1,
                name: 'Older',
                slug: 'older',
                body: '<p>Older body.</p>',
                published_at: '2026-01-01T00:00:00Z',
                status: 'published',
              },
              {
                id: 2,
                name: 'Newer',
                slug: 'newer',
                body: '<p>Newer body.</p>',
                published_at: '2026-02-01T00:00:00Z',
                status: 'published',
              },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    const body = res.__json() as { posts: Array<{ slug: string; publishedAt: string }> }
    expect(body.posts.length).toBe(2)
    expect(body.posts[0]!.slug).toBe('newer')
    expect(body.posts[1]!.slug).toBe('older')
  })

  test('drops empty-body posts from the response', async () => {
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 9, slug: 'ark-code-of-conduct' }] }),
          { status: 200 },
        )
      }
      if (url.includes('/posts')) {
        return new Response(
          JSON.stringify({
            records: [
              {
                id: 1,
                name: 'No body',
                slug: 'no-body',
                body: '',
                published_at: '2026-01-01T00:00:00Z',
                status: 'published',
              },
              {
                id: 2,
                name: 'Has body',
                slug: 'has-body',
                body: '<p>Yes.</p>',
                published_at: '2026-01-02T00:00:00Z',
                status: 'published',
              },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    const body = res.__json() as { posts: Array<{ slug: string }> }
    expect(body.posts.length).toBe(1)
    expect(body.posts[0]!.slug).toBe('has-body')
  })

  test('stops paginating once CIRCLE_SPACE_POSTS_TARGET is reached', async () => {
    // Build a single 50-record page so the loop trips the target on page 1
    // without needing page 2. We assert no second /posts fetch is made.
    const records = Array.from({ length: 50 }, (_, i) => ({
      id: 100 + i,
      name: `Post ${i}`,
      slug: `post-${i}`,
      body: `<p>Body ${i}.</p>`,
      published_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      status: 'published',
    }))
    let postsPageCalls = 0
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 9, slug: 'ark-code-of-conduct' }] }),
          { status: 200 },
        )
      }
      if (url.includes('/posts')) {
        postsPageCalls += 1
        return new Response(JSON.stringify({ records }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(postsPageCalls).toBe(1)
  })
})

describe('GET /api/circle/broadcasts — sanity', () => {
  test('returns empty list when token is unset', async () => {
    const handler = findHandler(buildDeps({}), BROADCASTS_PATH)
    const req = makeReq(BROADCASTS_PATH, 'newsletter=the-call-me-back-newsletter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ posts: [] })
  })

  test('maps upstream 5xx to a 502', async () => {
    fetchImpl = async () => new Response('boom', { status: 500 })
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), BROADCASTS_PATH)
    const req = makeReq(BROADCASTS_PATH, 'newsletter=the-call-me-back-newsletter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(502)
    expect(res.__json()).toEqual({ error: 'circle_unavailable' })
  })
})
