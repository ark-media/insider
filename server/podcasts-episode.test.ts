// /api/podcasts/episode — the episode must belong to the show it was asked under.
//
// The route decides whether audio is withheld from `?show=` alone, and the
// episode id is a second, independent, caller-supplied parameter. These tests
// pin the other half of the gate: an id only resolves when the episode Beehiiv
// returns says it belongs to that show and is published. Everything else is the
// route's not-found (`{ episode: null }`), never shared-cacheable, and
// remembered briefly so a loop over random ids can't spend the Beehiiv quota.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { createCatchAllHandler } from './api'
import { makeFakeReq as makeReq, makeFakeRes as makeRes } from './test-utils'
import { clearPodcastCaches } from './routes/podcasts'

const PUBLIC_SHOW = 'pod_aaaa1111'
const PAID_SHOW = 'pod_bbbb2222'

// The paid show's id sits under its LEGACY env key (the slug was
// inside-call-me-back), which is what every environment still carries.
function buildHandler(extraEnv: Record<string, string> = {}) {
  return createCatchAllHandler({
    APP_BASE_URL: 'http://localhost:5173',
    BEEHIIV_API_KEY: 'test-token',
    BEEHIIV_PUBLICATION_ID_PODCASTS: 'pub_test',
    BEEHIIV_PODCAST_ID_CALL_ME_BACK: PUBLIC_SHOW,
    BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK: PAID_SHOW,
    ...extraEnv,
  })
}

function beehiivEpisode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ep_1',
    title: 'An episode',
    status: 'published',
    displayed_date: 1_750_000_000,
    description: '<p>Blurb.</p>',
    show_notes: '<p>Notes.</p>',
    audio_url: 'https://media.example/ep_1.mp3',
    show: { id: PUBLIC_SHOW },
    ...overrides,
  }
}

const originalFetch = globalThis.fetch
const fetchCalls: string[] = []
let fetchImpl: (url: string) => Promise<Response> = async () =>
  new Response('{}', { status: 200 })

globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push(url)
  return fetchImpl(url)
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  fetchCalls.length = 0
  fetchImpl = async () => new Response('{}', { status: 200 })
  clearPodcastCaches()
})

function respondWith(data: unknown, status = 200) {
  fetchImpl = async () => new Response(JSON.stringify({ data }), { status })
}

async function getEpisode(show: string, id: string, extraEnv: Record<string, string> = {}) {
  const res = makeRes()
  await buildHandler(extraEnv)(
    makeReq({ url: `/api/handler?_path=podcasts/episode&show=${show}&id=${id}` }),
    res,
  )
  return {
    status: res.statusCode,
    body: res.__json() as { episode: { audioUrl: string; id: string } | null },
    cacheControl: res.__headers()['cache-control'],
  }
}

describe('/api/podcasts/episode — episode ownership', () => {
  test('serves a published episode of the requested public show, shared-cacheable', async () => {
    respondWith(beehiivEpisode())

    const { status, body, cacheControl } = await getEpisode('call-me-back', 'ep_1')

    expect(status).toBe(200)
    expect(body.episode?.id).toBe('ep_1')
    expect(body.episode?.audioUrl).toBe('https://media.example/ep_1.mp3')
    expect(cacheControl).toMatch(/^public, s-maxage=900/)
  })

  test('matches the show id with or without its pod_ prefix', async () => {
    respondWith(beehiivEpisode({ show: { id: 'AAAA1111' } }))

    const { body } = await getEpisode('call-me-back', 'ep_1')

    expect(body.episode?.id).toBe('ep_1')
  })

  test("a paid show's episode id under a public show's slug is not found, and its audio never leaves", async () => {
    // The attack: `?show=` names a public show, so the paid gate stands down and
    // the response is marked for the shared edge — while `id` names an episode
    // of the paid show.
    respondWith(
      beehiivEpisode({
        id: 'ep_paid',
        audio_url: 'https://media.example/paid.mp3',
        show: { id: PAID_SHOW },
      }),
    )

    const res = makeRes()
    await buildHandler()(
      makeReq({
        url: '/api/handler?_path=podcasts/episode&show=call-me-back&id=ep_paid',
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ episode: null })
    expect(res.__body()).not.toContain('paid.mp3')
    expect(res.__headers()['cache-control']).toBe('private, no-store')
  })

  // Nothing in the repo proves the single-episode endpoint always carries a
  // nested `show`. When it doesn't, ownership is settled by the requested show's
  // own published list, which comes from that podcast's list endpoint and so can
  // only hold its episodes. Just failing closed would be equally safe and would
  // blank every episode page the day Beehiiv omits the field.
  const showless = (listed: unknown[]) => {
    fetchImpl = async (url) =>
      new Response(
        JSON.stringify(
          /\/episodes\/[^/?]+(\?|$)/.test(url)
            ? { data: beehiivEpisode({ show: undefined }) }
            : { data: listed, total_results: listed.length, total_pages: 1, page: 1 },
        ),
        { status: 200 },
      )
  }

  test('an episode that does not name its show is served when the show lists it', async () => {
    showless([beehiivEpisode({ show: undefined })])

    const { body } = await getEpisode('call-me-back', 'ep_1')

    expect(body.episode?.id).toBe('ep_1')
  })

  test('an episode that does not name its show, and that the show does not list, is not found', async () => {
    showless([beehiivEpisode({ id: 'ep_other', show: undefined })])

    const { body, cacheControl } = await getEpisode('call-me-back', 'ep_1')

    expect(body).toEqual({ episode: null })
    expect(cacheControl).toBe('private, no-store')
  })

  for (const status of ['draft', 'scheduled', 'archived']) {
    test(`a ${status} episode is not found even though its id resolves`, async () => {
      respondWith(beehiivEpisode({ status }))

      const { body, cacheControl } = await getEpisode('call-me-back', 'ep_1')

      expect(body).toEqual({ episode: null })
      expect(cacheControl).toBe('private, no-store')
    })
  }

  test('a paid show still withholds audio from a caller with no membership', async () => {
    respondWith(beehiivEpisode({ show: { id: PAID_SHOW } }))

    const { body, cacheControl } = await getEpisode('call-me-back-plus', 'ep_1')

    expect(body.episode?.id).toBe('ep_1')
    expect(body.episode?.audioUrl).toBe('')
    expect(cacheControl).toBe('private, no-store')
  })

  test("the renamed show's own env key wins over the legacy one", async () => {
    const RENAMED = 'pod_cccc3333'
    respondWith(beehiivEpisode({ show: { id: RENAMED } }))

    const { body } = await getEpisode('call-me-back-plus', 'ep_1', {
      BEEHIIV_PODCAST_ID_CALL_ME_BACK_PLUS: RENAMED,
    })

    expect(body.episode?.id).toBe('ep_1')
    expect(fetchCalls[0]).toContain(RENAMED)
  })
})

describe('/api/podcasts/episode — negative caching', () => {
  test('an id Beehiiv does not know is a not-found, asked upstream once', async () => {
    respondWith(undefined, 404)

    const first = await getEpisode('call-me-back', 'nope')
    const second = await getEpisode('call-me-back', 'nope')

    expect(first.status).toBe(200)
    expect(first.body).toEqual({ episode: null })
    expect(first.cacheControl).toBe('private, no-store')
    expect(second.body).toEqual({ episode: null })
    expect(fetchCalls).toHaveLength(1)
  })

  test('a cross-show id is remembered too', async () => {
    respondWith(beehiivEpisode({ show: { id: PAID_SHOW } }))

    await getEpisode('call-me-back', 'ep_1')
    await getEpisode('call-me-back', 'ep_1')

    expect(fetchCalls).toHaveLength(1)
  })

  test('an upstream outage is a 502 and is NOT remembered', async () => {
    respondWith(undefined, 503)
    const down = await getEpisode('call-me-back', 'ep_1')
    expect(down.status).toBe(502)

    respondWith(beehiivEpisode())
    const up = await getEpisode('call-me-back', 'ep_1')
    expect(up.body.episode?.id).toBe('ep_1')
    expect(fetchCalls).toHaveLength(2)
  })

  test('the negative cache is bounded: the oldest id is forgotten first', async () => {
    respondWith(undefined, 404)

    await getEpisode('call-me-back', 'first')
    for (let i = 0; i < 500; i++) await getEpisode('call-me-back', `filler-${i}`)
    fetchCalls.length = 0

    // `first` was evicted to make room, so it costs an upstream call again; the
    // newest filler is still remembered and costs nothing.
    await getEpisode('call-me-back', 'filler-499')
    expect(fetchCalls).toHaveLength(0)
    await getEpisode('call-me-back', 'first')
    expect(fetchCalls).toHaveLength(1)
  })
})
