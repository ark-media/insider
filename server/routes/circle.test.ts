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
mock.module('@neondatabase/serverless', () => ({
  neon:
    (_url: string) =>
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const merged = strings.join('?')
      if (merged.includes('from membership where auth0_sub')) {
        return Promise.resolve(membershipRow ? [membershipRow] : [])
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
    sc_user_id: null,
    tier: 'circle',
    status: 'active',
    plan: 'monthly',
    amount_cents: 800,
    current_period_end: null,
    cancel_at: null,
    gift_expires_at: null,
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
  membershipRow = null
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

  // members-letter is bound at the ark-plus tier, so its posts are gated: the
  // response must never be publicly cached (it is identity-scoped) and bodies
  // must be withheld from non-members.
  test('sets private cache-control for a gated (ark-plus) space', async () => {
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
    expect(res.__header('cache-control')).toBe('private, no-store')
  })

  test('withholds post bodies from non-members of a gated space', async () => {
    membershipRow = null // no membership → not a circle member
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 9, slug: 'ark-code-of-conduct' }] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          records: [
            {
              id: 1,
              name: 'Members only',
              slug: 'secret',
              body: '<p>Paid body.</p>',
              published_at: '2026-02-01T00:00:00Z',
              status: 'published',
            },
          ],
        }),
        { status: 200 },
      )
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACE_POSTS_PATH)
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    const body = res.__json() as {
      posts: Array<{ slug: string; title: string; body: string; bodyHtml: string }>
    }
    expect(body.posts.length).toBe(1)
    // Metadata still ships (so the client can render a locked teaser + CTA)…
    expect(body.posts[0]!.title).toBe('Members only')
    // …but the paid body must not.
    expect(body.posts[0]!.body).toBe('')
    expect(body.posts[0]!.bodyHtml).toBe('')
  })

  test('returns full post bodies to circle members', async () => {
    membershipRow = circleMembershipRow() // staged live circle membership
    fetchImpl = async (url) => {
      if (url.includes('/spaces')) {
        return new Response(
          JSON.stringify({ records: [{ id: 9, slug: 'ark-code-of-conduct' }] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          records: [
            {
              id: 1,
              name: 'Members only',
              slug: 'secret',
              body: '<p>Paid body.</p>',
              published_at: '2026-02-01T00:00:00Z',
              status: 'published',
            },
          ],
        }),
        { status: 200 },
      )
    }
    const token = await signCheckoutToken(
      'member@example.com',
      MEMBER_ENV,
      CIRCLE_MEMBER_SUB,
    )
    const req = makeReq(SPACE_POSTS_PATH, 'newsletter=members-letter')
    ;(req.headers as Record<string, string>).cookie = `ark_checkout=${token}`
    const handler = findHandler(buildDeps(MEMBER_ENV), SPACE_POSTS_PATH)
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    const body = res.__json() as { posts: Array<{ bodyHtml: string }> }
    expect(body.posts.length).toBe(1)
    expect(body.posts[0]!.bodyHtml).toContain('Paid body.')
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
    const req = makeReq(BROADCASTS_PATH, 'newsletter=ark-daily')
    const res = makeRes()
    await handler(req, res)
    expect(res.__status()).toBe(200)
    expect(res.__json()).toEqual({ posts: [] })
  })
})

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

  test('maps upstream 5xx to 502', async () => {
    fetchImpl = async () => new Response('down', { status: 500 })
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), EVENTS_PATH)
    const res = makeRes()
    await handler(makeReq(EVENTS_PATH, ''), res)
    expect(res.__status()).toBe(502)
    expect(res.__json()).toEqual({ error: 'circle_unavailable' })
  })

  test('projects events and sets SWR cache-control', async () => {
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
              url: 'https://app.arkmedia.org/c/events-71d23b/coalition-roundtable',
            },
          ],
        }),
        { status: 200 },
      )
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), EVENTS_PATH)
    const res = makeRes()
    await handler(makeReq(EVENTS_PATH, ''), res)
    expect(res.__status()).toBe(200)
    const body = res.__json() as { events: Array<{ id: string; deepLink: string }> }
    expect(body.events.length).toBe(1)
    expect(body.events[0]!.id).toBe('coalition-roundtable')
    expect(body.events[0]!.deepLink).toBe(
      'https://app.arkmedia.org/c/events-71d23b/coalition-roundtable',
    )
    expect(res.__header('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=3600',
    )
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
          JSON.stringify({ records: [{ id: 77, slug: 'exclusive-ark-content' }] }),
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
                url: 'https://app.arkmedia.org/c/exclusive-ark-content/older',
              },
              {
                id: 2,
                name: 'Newer',
                body: '<p>Newer.</p>',
                published_at: '2026-02-01T00:00:00Z',
                status: 'published',
                user_name: 'Ava',
                space_name: 'Exclusive Ark+ Content',
                url: 'https://app.arkmedia.org/c/exclusive-ark-content/newer',
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
              { id: 1, slug: 'events-71d23b', name: 'Virtual Events', space_type: 'event' },
              { id: 2, slug: 'start-here', name: 'Welcome!', space_type: 'basic' },
              { id: 3, slug: 'world', name: 'World', space_type: 'basic', url: 'https://app.arkmedia.org/c/world' },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const handler = findHandler(buildDeps({ CIRCLE_ADMIN_API_TOKEN: 't' }), SPACES_PATH)
    const res = makeRes()
    await handler(makeReq(SPACES_PATH, ''), res)
    const body = res.__json() as { spaces: Array<{ id: string; href: string }> }
    expect(body.spaces.map((s) => s.id)).toEqual(['world'])
    expect(body.spaces[0]!.href).toBe('https://app.arkmedia.org/c/world')
  })
})
