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
    const body = res.__json() as {
      episode: { showNotesHtml: string; description: string }
    }
    expect(body.episode.showNotesHtml).toContain('Full notes')
    expect(body.episode.showNotesHtml).toContain('href="https://example.com"')
    expect(body.episode.showNotesHtml).not.toContain('<script')
    expect(body.episode.description).toBe('Short blurb.')
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

  test('/api/podcasts/episodes omits show notes from the list payload', async () => {
    // The list is fetched five-at-a-time to render the home page's four cards,
    // and nothing on it renders notes. Shipping them would be ~250KB per show
    // of HTML plus a sanitize pass per episode, for a field no caller reads.
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
                show_notes: '<p>A very long set of notes.</p>',
                duration: 1800,
                displayed_date: 1777899600,
                status: 'published',
              },
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

    const body = res.__json() as { episodes: Array<Record<string, unknown>> }
    expect(body.episodes).toHaveLength(1)
    expect(body.episodes[0]).not.toHaveProperty('showNotesHtml')
    expect(res.__body()).not.toContain('A very long set of notes')
  })

  test('/api/podcasts/episodes orders same-day episodes deterministically', async () => {
    // `publishedAt` is a calendar date, so a show that drops twice in one day
    // ties. A comparator that never returns 0 leaves the tie to the sort's
    // discretion, and the order could then differ between the cached and
    // freshly-fetched copies of the same list.
    const sameDay = (id: string) => ({
      id,
      slug: id,
      title: id,
      duration: 60,
      displayed_date: 1777899600,
      status: 'published',
    })
    fetchImpl = async (url) =>
      url.startsWith(EPISODES_URL)
        ? new Response(
            JSON.stringify({ data: [sameDay('ep-b'), sameDay('ep-a')] }),
            { status: 200 },
          )
        : new Response('{}', { status: 200 })

    const order = async () => {
      clearPodcastCaches()
      const res = makeRes()
      await handler(
        makeReq({
          url: '/api/handler?_path=podcasts/episodes&show=call-me-back',
        }),
        res,
      )
      return (res.__json() as { episodes: Array<{ id: string }> }).episodes.map(
        (e) => e.id,
      )
    }
    const handler = buildHandler()

    expect(await order()).toEqual(['ep-a', 'ep-b'])
    expect(await order()).toEqual(['ep-a', 'ep-b'])
  })

  test('/api/podcasts/episodes withholds audio for a show outside the public catalog', async () => {
    // A Beehiiv audio_url is an unauthenticated mp3 link, so this route is the
    // gate on paid audio — the client-side Ark+ check decides what to render,
    // not who can listen. Fails closed: a show id configured for a slug that
    // isn't in src/data/shows.ts is treated as gated, and an anonymous caller
    // gets metadata without the url.
    fetchImpl = async (url) =>
      url.includes('/podcasts/pod_icmb/')
        ? new Response(
            JSON.stringify({
              data: [
                {
                  id: 'ep-1',
                  slug: 'members-only',
                  title: 'Members only',
                  duration: 600,
                  displayed_date: 1777899600,
                  status: 'published',
                  audio_url: 'https://podcasts.beehiiv.test/paid.mp3',
                },
              ],
            }),
            { status: 200 },
          )
        : new Response('{}', { status: 200 })

    const handler = createCatchAllHandler({
      APP_BASE_URL: 'http://localhost:5173',
      BEEHIIV_API_KEY: 'test-token',
      BEEHIIV_PUBLICATION_ID_PODCASTS: 'pub_test',
      BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK: 'pod_icmb',
    })
    const res = makeRes()
    await handler(
      makeReq({
        url: '/api/handler?_path=podcasts/episodes&show=inside-call-me-back',
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    const body = res.__json() as { episodes: Array<{ audioUrl: string }> }
    expect(body.episodes).toHaveLength(1)
    expect(body.episodes[0].audioUrl).toBe('')
    expect(res.__body()).not.toContain('paid.mp3')
  })

  test('podcast reads carry an edge cache header', async () => {
    // The in-process TTL cache only dedupes concurrent calls on one warm
    // instance (shared/ttl-cache.ts). Without a header, every cold start pays
    // the full 4.5-7.6s Beehiiv list call.
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })

    const handler = buildHandler()
    for (const path of ['podcasts/episodes', 'podcasts/show']) {
      const res = makeRes()
      await handler(
        makeReq({ url: `/api/handler?_path=${path}&show=call-me-back` }),
        res,
      )
      expect(res.__headers()['cache-control']).toMatch(
        /public, s-maxage=\d+, stale-while-revalidate=\d+/,
      )
    }
  })

  test('a malformed BEEHIIV_PODCAST_ID_* reads as unconfigured, not as an outage', async () => {
    // The id is interpolated into the upstream path. Sending a pasted dashboard
    // URL upstream earns a 400 that surfaces as a 502 — a config typo should
    // look like the empty state an unconfigured show gets, not like downtime.
    const handler = createCatchAllHandler({
      APP_BASE_URL: 'http://localhost:5173',
      BEEHIIV_API_KEY: 'test-token',
      BEEHIIV_PUBLICATION_ID_PODCASTS: 'pub_test',
      BEEHIIV_PODCAST_ID_CALL_ME_BACK:
        'https://app.beehiiv.com/podcasts/pod_01a0599f',
    })
    const res = makeRes()
    await handler(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ episodes: [] })
    expect(fetchCalls.some((c) => c.url.includes('beehiiv.com/v2'))).toBe(false)
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

// ===========================================================================
// Episode list paging + the cross-show "latest" route
// ===========================================================================

// Beehiiv's list endpoint costs time per episode, not per request, so the list
// is bought as several short pages at once rather than one long one. These
// tests pin the two things that makes load-bearing: that the pages are actually
// requested in parallel and merged, and that a duplicate across a page boundary
// can't reach the client.

function makeEpisode(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `ep-${n}`,
    slug: `episode-${n}`,
    title: `Episode ${n}`,
    duration: 1800,
    // Descending dates, one day apart, so episode 1 is the newest.
    displayed_date: 1777899600 - n * 86_400,
    status: 'published',
    ...overrides,
  }
}

/** Serves distinct episodes per `page`, the way Beehiiv does. */
function servePages(perPage: Record<number, unknown[]>): FetchImpl {
  return async (url) => {
    if (!url.startsWith(EPISODES_URL)) return new Response('{}', { status: 200 })
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    return new Response(JSON.stringify({ data: perPage[page] ?? [] }), {
      status: 200,
    })
  }
}

describe('/api/podcasts/episodes — parallel paging', () => {
  test('requests every page at once and merges them into one list', async () => {
    // Ten distinct episodes per page across five pages.
    const perPage: Record<number, unknown[]> = {}
    for (let page = 1; page <= 5; page++) {
      perPage[page] = Array.from({ length: 10 }, (_, i) =>
        makeEpisode((page - 1) * 10 + i + 1),
      )
    }
    fetchImpl = servePages(perPage)

    const res = makeRes()
    await buildHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      res,
    )

    const listCalls = fetchCalls.filter((c) => c.url.startsWith(EPISODES_URL))
    expect(listCalls).toHaveLength(5)
    expect(
      listCalls.map((c) => new URL(c.url).searchParams.get('page')).sort(),
    ).toEqual(['1', '2', '3', '4', '5'])
    // Each page is short — asking for all 50 at once is the slow thing we are
    // avoiding, so a regression to one big request should fail here.
    for (const call of listCalls) {
      expect(new URL(call.url).searchParams.get('limit')).toBe('10')
    }

    const body = res.__json() as { episodes: Array<{ slug: string }> }
    expect(body.episodes).toHaveLength(50)
    expect(body.episodes[0].slug).toBe('episode-1')
    expect(body.episodes[49].slug).toBe('episode-50')
  })

  test('drops an episode that offset paging served on two pages', async () => {
    // What a publish landing mid-fetch looks like: everything shifts down one,
    // so the last episode of page 1 shows up again at the top of page 2.
    fetchImpl = servePages({
      1: [makeEpisode(1), makeEpisode(2)],
      2: [makeEpisode(2), makeEpisode(3)],
    })

    const res = makeRes()
    await buildHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      res,
    )

    const body = res.__json() as { episodes: Array<{ slug: string }> }
    expect(body.episodes.map((e) => e.slug)).toEqual([
      'episode-1',
      'episode-2',
      'episode-3',
    ])
  })

  test('one failed page fails the whole list rather than serving a partial one', async () => {
    // A short list would otherwise be cached and served as if it were complete.
    fetchImpl = async (url) => {
      if (!url.startsWith(EPISODES_URL)) return new Response('{}', { status: 200 })
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      if (page === 3) return new Response('upstream boom', { status: 500 })
      return new Response(JSON.stringify({ data: [makeEpisode(page)] }), {
        status: 200,
      })
    }

    const res = makeRes()
    await buildHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/episodes&show=call-me-back' }),
      res,
    )

    expect(res.statusCode).toBe(502)
    expect((res.__json() as { error: string }).error).toBe('podcasts_unavailable')
  })
})

describe('/api/podcasts/latest', () => {
  const POD_FHS = 'pod_fhs'
  const FHS_URL = `https://api.beehiiv.com/v2/publications/pub_test/podcasts/${POD_FHS}/episodes`

  function buildMultiShowHandler() {
    return createCatchAllHandler({
      APP_BASE_URL: 'http://localhost:5173',
      BEEHIIV_API_KEY: 'test-token',
      BEEHIIV_PUBLICATION_ID_PODCASTS: 'pub_test',
      BEEHIIV_PODCAST_ID_CALL_ME_BACK: 'pod_cmb',
      BEEHIIV_PODCAST_ID_FOR_HEAVENS_SAKE: POD_FHS,
    })
  }

  test('merges the newest episodes across shows, newest first', async () => {
    fetchImpl = async (url) => {
      if (url.startsWith(EPISODES_URL)) {
        return new Response(
          JSON.stringify({
            data: [
              { ...makeEpisode(1), displayed_date: 1777899600 }, // newest
              { ...makeEpisode(3), displayed_date: 1777726800 },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.startsWith(FHS_URL)) {
        return new Response(
          JSON.stringify({
            data: [
              { ...makeEpisode(2, { id: 'fhs-2' }), displayed_date: 1777813200 },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }

    const res = makeRes()
    await buildMultiShowHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/latest&limit=3' }),
      res,
    )

    expect(res.statusCode).toBe(200)
    const body = res.__json() as {
      episodes: Array<{ id: string; showSlug: string }>
    }
    expect(body.episodes.map((e) => e.id)).toEqual(['ep-1', 'fhs-2', 'ep-3'])
    expect(body.episodes.map((e) => e.showSlug)).toEqual([
      'call-me-back',
      'for-heavens-sake',
      'call-me-back',
    ])
  })

  test('asks each show for only `limit` episodes, on one page', async () => {
    // The whole point of the route: the homepage used to pull five full
    // 50-episode lists to render four cards.
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })

    await buildMultiShowHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/latest&limit=4' }),
      makeRes(),
    )

    const calls = fetchCalls.filter((c) => c.url.includes('/episodes?'))
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const params = new URL(call.url).searchParams
      expect(params.get('limit')).toBe('4')
      expect(params.get('page')).toBe('1')
      expect(params.get('status')).toBe('published')
    }
  })

  test('clamps an absurd limit instead of fetching every episode', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })

    await buildMultiShowHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/latest&limit=9999' }),
      makeRes(),
    )

    const call = fetchCalls.find((c) => c.url.includes('/episodes?'))!
    expect(new URL(call.url).searchParams.get('limit')).toBe('12')
  })

  test('still renders the strip when one show is unavailable', async () => {
    fetchImpl = async (url) => {
      if (url.startsWith(EPISODES_URL)) {
        return new Response('upstream boom', { status: 500 })
      }
      if (url.startsWith(FHS_URL)) {
        return new Response(JSON.stringify({ data: [makeEpisode(1)] }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 200 })
    }

    const res = makeRes()
    await buildMultiShowHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/latest' }),
      res,
    )

    expect(res.statusCode).toBe(200)
    const body = res.__json() as { episodes: Array<{ showSlug: string }> }
    expect(body.episodes.map((e) => e.showSlug)).toEqual(['for-heavens-sake'])
  })

  test('502s when every show fails, so the UI can offer a retry', async () => {
    fetchImpl = async () => new Response('upstream boom', { status: 500 })

    const res = makeRes()
    await buildMultiShowHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/latest' }),
      res,
    )

    expect(res.statusCode).toBe(502)
    expect((res.__json() as { error: string }).error).toBe('podcasts_unavailable')
  })

  test('is cacheable by a shared edge — it never carries gated audio', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })

    const res = makeRes()
    await buildMultiShowHandler()(
      makeReq({ url: '/api/handler?_path=podcasts/latest' }),
      res,
    )

    expect(res.getHeader('cache-control')).toContain('public')
    expect(res.getHeader('cache-control')).not.toContain('no-store')
  })

  test('returns an empty strip when credentials exist but no show is configured', async () => {
    // `[].every(...)` is true, so the "every show failed" check has to look at
    // the candidate count or this configuration 502s instead of rendering.
    const res = makeRes()
    await createCatchAllHandler({
      APP_BASE_URL: 'http://localhost:5173',
      BEEHIIV_API_KEY: 'test-token',
      BEEHIIV_PUBLICATION_ID_PODCASTS: 'pub_test',
    })(makeReq({ url: '/api/handler?_path=podcasts/latest' }), res)

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ episodes: [] })
    expect(fetchCalls).toHaveLength(0)
  })

  test('returns an empty strip without credentials rather than an error', async () => {
    const res = makeRes()
    await createCatchAllHandler({ APP_BASE_URL: 'http://localhost:5173' })(
      makeReq({ url: '/api/handler?_path=podcasts/latest' }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ episodes: [] })
    expect(fetchCalls).toHaveLength(0)
  })
})
