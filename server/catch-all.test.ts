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
import type { IncomingMessage } from 'node:http'
import { createCatchAllHandler } from './dev-api'
import { makeFakeRes as makeRes } from './test-utils'
import { clearPodcastCaches } from './routes/podcasts'

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

function buildHandler() {
  return createCatchAllHandler({
    SC_NETWORK_ID: 'test-net',
    SC_API_KEY: 'test-key',
    APP_BASE_URL: 'http://localhost:5173',
    BEEHIIV_API_KEY: 'test-token',
    BEEHIIV_PUBLICATION_ID_PODCASTS: 'pub_test',
    BEEHIIV_PODCAST_ID_CALL_ME_BACK: 'pod_cmb',
  })
}

const EPISODES_URL =
  'https://api.beehiiv.com/v2/publications/pub_test/podcasts/pod_cmb/episodes'

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
  clearPodcastCaches()
})

// ===========================================================================
// Tests
// ===========================================================================

describe('createCatchAllHandler — dispatch via _path query param', () => {
  test('multi-segment _path routes to the matching handler (regression: /api/podcasts/episodes returned NOT_FOUND under [...slug])', async () => {
    fetchImpl = async (url) => {
      if (url.startsWith(EPISODES_URL)) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'ep-1',
                slug: 'episode-one',
                title: 'Episode One',
                description: 'desc',
                duration: 1800,
                displayed_date: 1777899600,
                status: 'published',
                audio_url: 'https://media.beehiiv.test/ep-1.mp3',
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
      url: '/api/handler?_path=podcasts/episodes&show=call-me-back',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.__json() as {
      episodes: Array<{ slug: string; audioUrl: string; publishedAt: string }>
    }
    expect(body.episodes).toHaveLength(1)
    expect(body.episodes[0].slug).toBe('episode-one')
    expect(body.episodes[0].audioUrl).toBe('https://media.beehiiv.test/ep-1.mp3')
    expect(body.episodes[0].publishedAt).toBe('2026-05-04')
  })

  test('/api/podcasts/episodes asks Beehiiv for published episodes only', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })

    const handler = buildHandler()
    await handler(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      makeRes(),
    )

    const call = fetchCalls.find((c) => c.url.startsWith(EPISODES_URL))
    expect(call).toBeDefined()
    expect(call!.url).toContain('status=published')
    expect(call!.url).toContain('order_by=displayed_date')
    expect(call!.url).toContain('direction=desc')
  })

  test('/api/podcasts/episodes drops unpublished episodes Beehiiv still returns', async () => {
    fetchImpl = async (url) => {
      if (url.startsWith(EPISODES_URL)) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'ep-1', slug: 'live', displayed_date: 1777899600, status: 'published' },
              { id: 'ep-2', slug: 'draft', displayed_date: 1777899600, status: 'draft' },
              { id: 'ep-3', slug: 'soon', displayed_date: 1777899600, status: 'scheduled' },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }

    const handler = buildHandler()
    const res = makeRes()
    await handler(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      res,
    )

    const body = res.__json() as { episodes: Array<{ slug: string }> }
    expect(body.episodes.map((e) => e.slug)).toEqual(['live'])
  })

  test('inner handler still reads its own query params when _path is present', async () => {
    const handler = buildHandler()
    // Missing `show` should return 400 — proves the inner handler is parsing
    // searchParams and that _path coexists with real params without confusing it.
    const req = makeReq({ url: '/api/handler?_path=podcasts/episodes' })
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

  test('/api/podcasts/episode returns sanitized show notes', async () => {
    fetchImpl = async (url) => {
      if (url.startsWith(`${EPISODES_URL}/`)) {
        return new Response(
          JSON.stringify({
            data: {
              id: '2d482aab-31dd-4d0f-a858-5cc0cb9c7360',
              description: '<p>Short blurb.</p>',
              show_notes:
                '<p>Full notes <a href="https://example.com">link</a><script>alert(1)</script></p>',
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }

    const handler = buildHandler()
    const req = makeReq({
      url: '/api/handler?_path=podcasts/episode&show=call-me-back&id=2d482aab-31dd-4d0f-a858-5cc0cb9c7360',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.__json() as { showNotesHtml: string; description: string }
    expect(body.showNotesHtml).toContain('Full notes')
    expect(body.showNotesHtml).toContain('href="https://example.com"')
    expect(body.showNotesHtml).not.toContain('<script')
    expect(body.description).toBe('Short blurb.')
  })

  test('/api/podcasts/episode rejects path-traversal ids without hitting Beehiiv', async () => {
    const handler = buildHandler()
    const req = makeReq({
      url: '/api/handler?_path=podcasts/episode&show=call-me-back&id=../../etc/passwd',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toMatch(/invalid/)
    expect(fetchCalls.some((c) => c.url.includes('beehiiv.com'))).toBe(false)
  })

  test('/api/podcasts/episode accepts a prefixed Beehiiv id', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: { description: 'ok' } }), { status: 200 })

    const handler = buildHandler()
    const res = makeRes()
    await handler(
      makeReq({
        url: '/api/handler?_path=podcasts/episode&show=call-me-back&id=pod_ep_01a0599f',
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(fetchCalls.some((c) => c.url.endsWith('/pod_ep_01a0599f'))).toBe(true)
  })

  test('a podcast id configured without the pod_ prefix is normalised', async () => {
    // Beehiiv enforces `^pod_[0-9a-fA-F-]+$` on this path segment and 400s on a
    // bare uuid, but shows the id unprefixed in places — so both forms must work.
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })

    const handler = createCatchAllHandler({
      APP_BASE_URL: 'http://localhost:5173',
      BEEHIIV_API_KEY: 'test-token',
      BEEHIIV_PUBLICATION_ID_PODCASTS: 'pub_test',
      BEEHIIV_PODCAST_ID_CALL_ME_BACK: '01a0599f-c7dc-725e-a326-2afd78c94e7e',
    })
    await handler(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      makeRes(),
    )

    expect(
      fetchCalls.some((c) =>
        c.url.includes('/podcasts/pod_01a0599f-c7dc-725e-a326-2afd78c94e7e/'),
      ),
    ).toBe(true)
  })

  test('/api/podcasts/show returns the stripped show description', async () => {
    fetchImpl = async (url) => {
      if (url === 'https://api.beehiiv.com/v2/publications/pub_test/podcasts/pod_cmb') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'pod_cmb',
              title: 'Call Me Back',
              description: '<p>The forces shaping the Israeli economy.</p>',
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }

    const handler = buildHandler()
    const req = makeReq({
      url: '/api/handler?_path=podcasts/show&show=call-me-back',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.__json() as { description: string }
    expect(body.description).toBe('The forces shaping the Israeli economy.')
  })

  test('a blank BEEHIIV_PUBLICATION_ID_PODCASTS falls back to the newsletter publication', async () => {
    // Regression: `??` treats a present-but-empty env var as set, which is how
    // both Vite's loadEnv and Vercel represent "declared but blank" — the
    // fallback has to be `||` or every show silently returns no episodes.
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })

    const handler = createCatchAllHandler({
      APP_BASE_URL: 'http://localhost:5173',
      BEEHIIV_API_KEY: 'test-token',
      BEEHIIV_PUBLICATION_ID_PODCASTS: '',
      BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_fallback',
      BEEHIIV_PODCAST_ID_CALL_ME_BACK: 'pod_cmb',
    })
    const res = makeRes()
    await handler(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(
      fetchCalls.some((c) => c.url.includes('/publications/pub_fallback/')),
    ).toBe(true)
  })

  test('/api/podcasts/show returns empty description for an unconfigured show without hitting Beehiiv', async () => {
    const handler = buildHandler()
    const req = makeReq({
      url: '/api/handler?_path=podcasts/show&show=unknown-show',
    })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ description: '' })
    expect(fetchCalls.some((c) => c.url.includes('beehiiv.com'))).toBe(false)
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
    const handler = createCatchAllHandler({
      SC_NETWORK_ID: 'test-net',
      SC_API_KEY: 'test-key',
      APP_BASE_URL: 'http://localhost:5173',
    })
    const req = makeReq({
      url: '/api/podcasts/episodes?show=unknown-show',
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
