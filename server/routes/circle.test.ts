// Tests for the /api/circle/space-posts route. Wires `circleRoutes()` with a
// minimal Deps bundle and exercises the handler with fake req/res, monkey-
// patching `fetch` per test so no real Circle calls leave the process.
//
// Covers the pagination loop, missing-token / missing-binding shortcuts,
// upstream error mapping, and the space-id → posts walk. The projection
// itself is covered by circle-space-posts.test.ts.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { __resetCircleCachesForTests, circleRoutes } from './circle.js'
import type { Deps } from '../lib/route.js'
import { signCheckoutToken } from '../lib/session.js'
import { silenceExpectedConsole } from '../test-utils.js'

// The community-feed gate now resolves entitlements from Neon (the `circle`
// axis). Stub @neondatabase/serverless so a staged membership row decides the
// gate; `membershipRow` is set per test and reset in beforeEach.
let membershipRow: Record<string, unknown> | null = null
// The companion threads the highlights feed subtracts from the space it reads.
// Empty for every test but the one that stages them.
let companionRows: Array<{ circle_post_id: string }> = []
mock.module('@neondatabase/serverless', () => ({
  neon:
    (_url: string) =>
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const merged = strings.join('?')
      if (merged.includes('from membership where auth0_sub')) {
        return Promise.resolve(membershipRow ? [membershipRow] : [])
      }
      if (merged.includes('select circle_post_id')) {
        return Promise.resolve(companionRows)
      }
      return Promise.resolve([])
    },
  __esModule: true,
}))

// A live Circle membership row keyed on the member's Auth0 sub (grants circle).
const CIRCLE_MEMBER_SUB = 'auth0|member'
function circleMembershipRow(): Record<string, unknown> {
  return {
    auth0_sub: CIRCLE_MEMBER_SUB,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    tier: 'circle',
    status: 'active',
    plan: 'monthly',
    amount_cents: 800,
    current_period_end: null,
    cancel_at: null,
    ark_plus_gift_expires_at: null,
    circle_gift_expires_at: null,
  }
}

// A post-checkout session secret + a request carrying a valid member cookie
// (with the member's sub), used to pass the community-feed subscriber gate. The
// gate reads the staged Neon row keyed on that sub.
const MEMBER_ENV = {
  CIRCLE_ADMIN_API_TOKEN: 't',
  CHECKOUT_SESSION_SECRET: 'test-secret-0123456789abcdef0123456789',
  DATABASE_URL: 'postgres://stub-circle-test',
}
async function makeMemberReq(path: string): Promise<IncomingMessage> {
  const token = await signCheckoutToken('member@example.com', MEMBER_ENV, CIRCLE_MEMBER_SUB)
  const req = makeReq(path, '')
  ;(req.headers as Record<string, string>).cookie = `ark_checkout=${token}`
  return req
}

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
  membershipRow = null
  companionRows = []
  __resetCircleCachesForTests()
})

// --- Tests -----------------------------------------------------------------

// ---------------------------------------------------------------------------
// /community subscriber feed routes
// ---------------------------------------------------------------------------

const EVENTS_PATH = '/api/circle/community-events'
const FEED_PATH = '/api/circle/community-feed'
const SPACES_PATH = '/api/circle/spaces'

describe('GET /api/circle/community-events', () => {
  test('returns { events: [] } when token is unset, no upstream call', async () => {
    const handler = findHandler(buildDeps({}), EVENTS_PATH)
    const res = makeRes()
    await handler(makeReq(EVENTS_PATH, ''), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ events: [] })
    expect(fetchCalls.length).toBe(0)
  })

  test('rejects non-GET with 405', async () => {
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), EVENTS_PATH)
    const req = makeReq(EVENTS_PATH, '')
    ;(req as { method: string }).method = 'POST'
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(405)
  })

  test('withholds the calendar from an unauthenticated caller', async () => {
    // The projection ships `venue` — the physical address of in-person member
    // events — so a caller without the circle axis must get nothing, and no
    // upstream call should be made on their behalf.
    fetchImpl = async (url) => {
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), EVENTS_PATH)
    const res = makeRes()
    await handler(makeReq(EVENTS_PATH, ''), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ events: [] })
    expect(res.__header('cache-control')).toBe('private, no-store')
    expect(fetchCalls.length).toBe(0)
  })

  test('maps upstream 5xx to 502', async () => {
    fetchImpl = async () => new Response('down', { status: 500 })
    membershipRow = circleMembershipRow()
    const handler = findHandler(buildDeps(MEMBER_ENV), EVENTS_PATH)
    const res = makeRes()
    await handler(await makeMemberReq(EVENTS_PATH), res)
    expect(res.__status()).toBe(502)
    expect(res.__json()).toEqual({ error: 'circle_unavailable' })
  })

  test('projects events for a member and never shared-caches them', async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          has_next_page: false,
          records: [
            {
              id: 1,
              name: 'Coalition Roundtable',
              slug: 'coalition-roundtable',
              starts_at: '2026-06-07T19:00:00.000Z',
              duration_in_seconds: 3600,
              location_type: 'live_room',
              host: 'Noa',
              url: 'https://thefold.arkmedia.org/c/events-71d23b/coalition-roundtable',
            },
          ],
        }),
        { status: 200 },
      )
    membershipRow = circleMembershipRow()
    const handler = findHandler(buildDeps(MEMBER_ENV), EVENTS_PATH)
    const res = makeRes()
    await handler(await makeMemberReq(EVENTS_PATH), res)
    expect(res.__status()).toBe(200)
    const body = res.__json() as { events: Array<{ id: string; deepLink: string }> }
    expect(body.events.length).toBe(1)
    expect(body.events[0]!.id).toBe('coalition-roundtable')
    expect(body.events[0]!.deepLink).toBe(
      'https://thefold.arkmedia.org/c/events-71d23b/coalition-roundtable',
    )
    expect(res.__header('cache-control')).toBe('private, no-store')
  })
})

describe('GET /api/circle/community-feed', () => {
  test('returns { items: [] } when token is unset', async () => {
    const handler = findHandler(buildDeps({}), FEED_PATH)
    const res = makeRes()
    await handler(makeReq(FEED_PATH, ''), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ items: [] })
  })

  test('withholds content from an unauthenticated caller (subscriber gate)', async () => {
    // Token present, but no member session on the request → empty, no upstream.
    fetchImpl = async (url) => {
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), FEED_PATH)
    const res = makeRes()
    await handler(makeReq(FEED_PATH, ''), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ items: [] })
    expect(res.__header('cache-control')).toBe('private, no-store')
    expect(fetchCalls.length).toBe(0)
  })

  test('resolves the feed space, projects posts, sorts newest-first (member)', async () => {
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 77, slug: 'conversation' }] }),
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
                body: '<p>Older.</p>',
                published_at: '2026-01-01T00:00:00Z',
                status: 'published',
                user_name: 'Ava',
                space_name: 'Exclusive Ark+ Content',
                url: 'https://thefold.arkmedia.org/c/conversation/older',
              },
              {
                id: 2,
                name: 'Newer',
                body: '<p>Newer.</p>',
                published_at: '2026-02-01T00:00:00Z',
                status: 'published',
                user_name: 'Ava',
                space_name: 'Exclusive Ark+ Content',
                url: 'https://thefold.arkmedia.org/c/conversation/newer',
              },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    membershipRow = circleMembershipRow()
    const handler = findHandler(buildDeps(MEMBER_ENV), FEED_PATH)
    const res = makeRes()
    await handler(await makeMemberReq(FEED_PATH), res)
    const body = res.__json() as { items: Array<{ id: string; title: string }> }
    expect(body.items.map((i) => i.title)).toEqual(['Newer', 'Older'])
  })

  test('leaves out the companion threads we posted into the same space', async () => {
    // The discuss bindings post one thread per newsletter article into
    // `conversation`, which is the space this feed reads. Left in, the
    // highlights feed becomes a list of our own auto-generated stubs and
    // nothing else, within a few sends.
    companionRows = [{ circle_post_id: '1' }]
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 77, slug: 'conversation' }] }),
          { status: 200 },
        )
      }
      if (url.includes('/posts')) {
        return new Response(
          JSON.stringify({
            records: [
              {
                id: 1,
                name: 'Discuss: this week in the newsletter',
                body: '<p>Discussion for…</p>',
                published_at: '2026-02-02T00:00:00Z',
                status: 'published',
              },
              {
                id: 2,
                name: 'What we owe each other',
                body: '<p>A real post.</p>',
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
    membershipRow = circleMembershipRow()
    const handler = findHandler(buildDeps(MEMBER_ENV), FEED_PATH)
    const res = makeRes()
    await handler(await makeMemberReq(FEED_PATH), res)
    const body = res.__json() as { items: Array<{ id: string; title: string }> }
    // The stub is the NEWER of the two, so it would otherwise lead the feed.
    expect(body.items.map((i) => i.title)).toEqual(['What we owe each other'])
  })
})

describe('GET /api/circle/spaces', () => {
  test('returns { spaces: [] } when token is unset', async () => {
    const handler = findHandler(buildDeps({}), SPACES_PATH)
    const res = makeRes()
    await handler(makeReq(SPACES_PATH, ''), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ spaces: [] })
  })

  test('projects member-facing spaces, excluding system/event spaces', async () => {
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({
            records: [
              { id: 1, slug: 'events', name: 'Events', space_type: 'event' },
              { id: 2, slug: 'get-started', name: 'Get started', space_type: 'basic' },
              { id: 3, slug: 'world', name: 'World', space_type: 'basic', url: 'https://thefold.arkmedia.org/c/world' },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    membershipRow = circleMembershipRow()
    const handler = findHandler(buildDeps(MEMBER_ENV), SPACES_PATH)
    const res = makeRes()
    await handler(await makeMemberReq(SPACES_PATH), res)
    const body = res.__json() as { spaces: Array<{ id: string; href: string }> }
    expect(body.spaces.map((s) => s.id)).toEqual(['world'])
    expect(body.spaces[0]!.href).toBe('https://thefold.arkmedia.org/c/world')
    expect(res.__header('cache-control')).toBe('private, no-store')
  })

  test('withholds the space directory from an unauthenticated caller', async () => {
    fetchImpl = async (url) => {
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACES_PATH)
    const res = makeRes()
    await handler(makeReq(SPACES_PATH, ''), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ spaces: [] })
    expect(res.__header('cache-control')).toBe('private, no-store')
    expect(fetchCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// /api/circle/showcase — the PUBLIC marketing grid on /fold
//
// The one Circle route with no gate, so what it must *not* do is as important
// as what it returns: never read an off-allowlist space, never fail the page.
// ---------------------------------------------------------------------------

const SHOWCASE_PATH = '/api/circle/showcase'

// Spaces payload covering the three allowlisted rooms plus the ones the
// showcase must leave alone.
const SHOWCASE_SPACES = {
  records: [
    { id: 10, slug: 'conversation', name: 'The Conversation' },
    { id: 20, slug: 'ask-share', name: 'Ask & Share' },
    { id: 30, slug: 'lounge', name: 'The Lounge' },
    { id: 40, slug: 'say-hi', name: 'Introduce Yourself' },
    { id: 50, slug: 'announcements', name: 'Announcements' },
  ],
}

function showcasePost(
  id: number,
  spaceId: number,
  spaceSlug: string,
  spaceName: string,
  publishedAt: string,
) {
  return {
    id,
    name: `Post ${id}`,
    space_id: spaceId,
    space_slug: spaceSlug,
    space_name: spaceName,
    status: 'published',
    published_at: publishedAt,
    user_name: 'Ava Weiner',
    user_email: 'ava@arkmedia.org',
    comments_count: 2,
    likes_count: 0,
    url: `https://thefold.arkmedia.org/c/${spaceSlug}/post-${id}`,
  }
}

/** Serves spaces, per-space posts, and the member profile lookup. */
function showcaseFetch(): FetchImpl {
  return async (url) => {
    if (url.includes('/community_members/search')) {
      return new Response(
        JSON.stringify({
          avatar_url: 'https://app.circle.so/avatar.png',
          flattened_profile_fields: {
            location: 'New York City, New York, United States',
          },
        }),
        { status: 200 },
      )
    }
    if (url.includes('/posts?space_id=10')) {
      return new Response(
        JSON.stringify({
          records: [showcasePost(1, 10, 'conversation', 'The Conversation', '2026-09-08T00:00:00Z')],
          has_next_page: false,
        }),
        { status: 200 },
      )
    }
    if (url.includes('/posts?space_id=20')) {
      return new Response(
        JSON.stringify({
          records: [showcasePost(2, 20, 'ask-share', 'Ask & Share', '2026-09-10T00:00:00Z')],
          has_next_page: false,
        }),
        { status: 200 },
      )
    }
    if (url.includes('/posts?space_id=30')) {
      return new Response(
        JSON.stringify({
          records: [showcasePost(3, 30, 'lounge', 'The Lounge', '2026-09-09T00:00:00Z')],
          has_next_page: false,
        }),
        { status: 200 },
      )
    }
    if (url.includes('/spaces')) {
      return new Response(JSON.stringify(SHOWCASE_SPACES), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

describe('GET /api/circle/showcase', () => {
  test('serves real posts to an unauthenticated visitor', async () => {
    fetchImpl = showcaseFetch()
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    const res = makeRes()
    // No cookie, no membership row staged — a logged-out visitor.
    await handler(makeReq(SHOWCASE_PATH, ''), res)

    expect(res.__status()).toBe(200)
    const body = res.__json() as { posts: Array<Record<string, unknown>> }
    expect(body.posts).toHaveLength(3)
    // Newest first across all three rooms.
    expect(body.posts.map((p) => p.roomSlug)).toEqual([
      'ask-share',
      'lounge',
      'conversation',
    ])
    expect(body.posts[0]!.authorName).toBe('Ava W.')
    expect(body.posts[0]!.authorLocation).toBe('New York City')
    expect(body.posts[0]!.replyCount).toBe(2)
  })

  test('is edge-cacheable — unlike every gated Circle route', async () => {
    fetchImpl = showcaseFetch()
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    const res = makeRes()
    await handler(makeReq(SHOWCASE_PATH, ''), res)
    expect(res.__header('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=600',
    )
  })

  test('never reads a space outside the allowlist', async () => {
    fetchImpl = showcaseFetch()
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    await handler(makeReq(SHOWCASE_PATH, ''), makeRes())

    const postReads = fetchCalls.filter((c) => c.url.includes('/posts?space_id='))
    expect(postReads).toHaveLength(3)
    // say-hi (40) and announcements (50) are never fetched at all.
    expect(postReads.some((c) => c.url.includes('space_id=40'))).toBe(false)
    expect(postReads.some((c) => c.url.includes('space_id=50'))).toBe(false)
  })

  test('subtracts our own newsletter companion stubs', async () => {
    companionRows = [{ circle_post_id: '2' }]
    fetchImpl = showcaseFetch()
    const handler = findHandler(
      buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't', DATABASE_URL: 'postgres://stub' }),
      SHOWCASE_PATH,
    )
    const res = makeRes()
    await handler(makeReq(SHOWCASE_PATH, ''), res)
    const body = res.__json() as { posts: Array<{ id: string }> }
    expect(body.posts.map((p) => p.id)).not.toContain('2')
    expect(body.posts).toHaveLength(2)
  })

  test('looks each author up once, not once per post', async () => {
    fetchImpl = showcaseFetch()
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    await handler(makeReq(SHOWCASE_PATH, ''), makeRes())
    const lookups = fetchCalls.filter((c) => c.url.includes('/community_members/search'))
    expect(lookups).toHaveLength(1)
  })

  test('still renders the posts when the author lookup 404s', async () => {
    const inner = showcaseFetch()
    fetchImpl = async (url, init) => {
      if (url.includes('/community_members/search')) {
        return new Response('{"success":false}', { status: 404 })
      }
      return inner(url, init)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    const res = makeRes()
    await handler(makeReq(SHOWCASE_PATH, ''), res)
    const body = res.__json() as { posts: Array<Record<string, unknown>> }
    expect(body.posts).toHaveLength(3)
    expect(body.posts[0]!.authorLocation).toBeUndefined()
  })

  test('returns { posts: [] } when token is unset, no upstream call', async () => {
    const handler = findHandler(buildDeps({}), SHOWCASE_PATH)
    const res = makeRes()
    await handler(makeReq(SHOWCASE_PATH, ''), res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ posts: [] })
    expect(fetchCalls.length).toBe(0)
  })

  test('degrades to empty (200, not 502) when Circle is down', async () => {
    fetchImpl = async () => new Response('upstream boom', { status: 500 })
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    const res = makeRes()
    await handler(makeReq(SHOWCASE_PATH, ''), res)
    // 200: this feeds one marketing section, so the client hides the section
    // rather than showing the whole page an error.
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ posts: [] })
  })

  test('skips a renamed room instead of failing the grid', async () => {
    const inner = showcaseFetch()
    fetchImpl = async (url, init) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({
            records: SHOWCASE_SPACES.records.filter((s) => s.slug !== 'lounge'),
          }),
          { status: 200 },
        )
      }
      return inner(url, init)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    const res = makeRes()
    await handler(makeReq(SHOWCASE_PATH, ''), res)
    const body = res.__json() as { posts: Array<{ roomSlug: string }> }
    expect(body.posts.map((p) => p.roomSlug)).toEqual(['ask-share', 'conversation'])
  })

  test('rejects non-GET with 405', async () => {
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SHOWCASE_PATH)
    const req = makeReq(SHOWCASE_PATH, '')
    ;(req as { method: string }).method = 'POST'
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(405)
  })
})
