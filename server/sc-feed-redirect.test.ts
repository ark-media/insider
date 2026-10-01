// The Supporting Cast → Beehiiv feed redirect (routes/sc-feed-redirect.ts) and
// the token decoder it rests on (shared/sc-feed-token.ts).
//
// Neon and Beehiiv are both mocked: the table lookup answers from `members`,
// the by-email feed read from `beehiivAnswer`. The token below is a real one
// from the SC export with its signature left intact — the decoder must read
// `u` out of it without caring about the rest.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  neonMockModule,
  type SqlCall,
  makeFakeReq,
  makeFakeRes,
  silenceExpectedConsole,
} from './test-utils'
import { decodeScFeedToken } from '../shared/sc-feed-token'

const sqlCalls: SqlCall[] = []
let members: Array<{ sc_user_id: string; email: string; sc_status: string }> = []
let sqlFails = false

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql, values) => {
    if (sqlFails) throw new Error('neon down')
    if (sql.includes('from sc_feed_members')) {
      return members.filter((m) => m.sc_user_id === String(values[0]))
    }
    return []
  }),
)

import { scFeedRedirectRoutes, feedMovedRss } from './routes/sc-feed-redirect'
import { clearPrivateFeedCache } from './lib/beehiiv-feeds'
import type { Deps } from './lib/route'

const SHOW_ID = 'pod_01a05d4d-d91e-7d23-b20e-7c225707635e'
const BEEHIIV_URL = `https://rss.beehiiv.com/podcasts/${SHOW_ID}/private/Y4XVUDuLzwbR3ejULET89bSUKGV2z6m2.xml`

// {"t":"p","c":"20081","u":"3041995","d":"1752754983","k":10350}|a8ca…724a
const TOKEN =
  'eyJ0IjoicCIsImMiOiIyMDA4MSIsInUiOiIzMDQxOTk1IiwiZCI6IjE3NTI3NTQ5ODMiLCJrIjoxMDM1MH18' +
  'YThjYWFkMDJmZDRhYWJhMGVmY2Y5ZmUwMDVmZjZiNDY0NmNmYTQxMTQyNjgzYjg1OWZlZWY3Y2YzYzU5NzI0YQ'

type BeehiivAnswer = { status: number; show?: string }
let beehiivAnswer: BeehiivAnswer = { status: 404 }
let beehiivCalls = 0

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.includes('/private_feeds/by_email/')) {
    beehiivCalls++
    const { status, show } = beehiivAnswer
    if (status !== 200) return new Response('{"errors":[]}', { status })
    return new Response(
      JSON.stringify({
        data: {
          id: 'pod_feed_x',
          url: BEEHIIV_URL,
          protocol_links: {},
          created: 1,
          show: { id: show ?? SHOW_ID, title: 'Inside Call Me Back' },
        },
      }),
      { status: 200 },
    )
  }
  return originalFetch(input)
}) as typeof fetch

silenceExpectedConsole()

const ENV: Record<string, string> = {
  APP_BASE_URL: 'https://ark.example',
  DATABASE_URL: 'postgres://stub',
  BEEHIIV_API_KEY: 'key',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: 'pub_x',
  SC_FEED_REDIRECT_SHOW_ID: SHOW_ID,
}

function deps(env: Record<string, string> = ENV): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: env.APP_BASE_URL ?? 'https://ark.example',
    activator: {} as Deps['activator'],
  }
}

async function get(token: string, env = ENV, method = 'GET') {
  const [route] = scFeedRedirectRoutes(deps(env))
  const res = makeFakeRes()
  await route!.handler(
    makeFakeReq({ method, url: `${route!.path}?token=${encodeURIComponent(token)}` }),
    res,
  )
  return res
}

beforeEach(() => {
  sqlCalls.length = 0
  members = [{ sc_user_id: '3041995', email: 'member@example.com', sc_status: 'active' }]
  sqlFails = false
  beehiivAnswer = { status: 404 }
  beehiivCalls = 0
  clearPrivateFeedCache()
})

describe('decodeScFeedToken', () => {
  test('reads c, u and the issue date from a real token', () => {
    const t = decodeScFeedToken(TOKEN)
    expect(t).toEqual({
      feedId: '20081',
      userId: '3041995',
      issuedAt: new Date('2025-07-17T12:23:03.000Z'),
    })
  })

  test('accepts a whole feed URL or path', () => {
    expect(decodeScFeedToken(`https://inside.arkmedia.org/content/${TOKEN}.rss`)?.userId).toBe(
      '3041995',
    )
    expect(decodeScFeedToken(`/content/${TOKEN}.rss`)?.userId).toBe('3041995')
  })

  test('rejects anything that is not an SC token', () => {
    expect(decodeScFeedToken('')).toBeNull()
    expect(decodeScFeedToken('not-a-token')).toBeNull()
    expect(decodeScFeedToken('../../etc/passwd')).toBeNull()
    // Valid base64 of JSON without a numeric `u`.
    expect(decodeScFeedToken(Buffer.from('{"u":"abc"}|sig').toString('base64url'))).toBeNull()
  })
})

describe('GET /content/<token>.rss', () => {
  test('301s to the Beehiiv feed for a known member with a feed', async () => {
    beehiivAnswer = { status: 200 }
    const res = await get(TOKEN)
    expect(res.statusCode).toBe(301)
    expect(res.__headers()['location']).toBe(BEEHIIV_URL)
    expect(res.__headers()['cache-control']).toContain('s-maxage=3600')
    expect(sqlCalls[0]!.values[0]).toBe('3041995')
    // Asked Beehiiv for the configured show only.
    expect(beehiivCalls).toBe(1)
  })

  test('serves the moved-feed stub when the member has no feed on the show', async () => {
    beehiivAnswer = { status: 404 }
    const res = await get(TOKEN)
    expect(res.statusCode).toBe(200)
    expect(res.__headers()['content-type']).toContain('application/rss+xml')
    expect(res.__headers()['cache-control']).toContain('s-maxage=60')
    expect(res.__body()).toBe(feedMovedRss('https://ark.example'))
    expect(res.__body()).toContain('https://ark.example/account/podcast-feed')
  })

  test('serves the stub for an SC user id we never exported', async () => {
    members = []
    beehiivAnswer = { status: 200 }
    const res = await get(TOKEN)
    expect(res.statusCode).toBe(200)
    expect(res.__body()).toContain('<rss')
    expect(beehiivCalls).toBe(0)
  })

  test('404s for a token that is not an SC token', async () => {
    const res = await get('garbage')
    expect(res.statusCode).toBe(404)
    expect(sqlCalls).toHaveLength(0)
  })

  test('503s with Retry-After when the lookup table is unreachable', async () => {
    sqlFails = true
    const res = await get(TOKEN)
    expect(res.statusCode).toBe(503)
    expect(res.__headers()['retry-after']).toBe('300')
    expect(res.__headers()['cache-control']).toBe('no-store')
  })

  test('503s rather than stubbing when Beehiiv is failing', async () => {
    beehiivAnswer = { status: 500 }
    const res = await get(TOKEN)
    expect(res.statusCode).toBe(503)
  })

  test('503s when the target show is public (misconfigured)', async () => {
    beehiivAnswer = { status: 422 }
    const res = await get(TOKEN)
    expect(res.statusCode).toBe(503)
  })

  test('503s when the target show is not configured', async () => {
    const { SC_FEED_REDIRECT_SHOW_ID: _unused, ...env } = ENV
    const res = await get(TOKEN, env)
    expect(res.statusCode).toBe(503)
    expect(sqlCalls).toHaveLength(0)
  })

  test('HEAD gets the same status and headers with no body', async () => {
    beehiivAnswer = { status: 200 }
    const res = await get(TOKEN, ENV, 'HEAD')
    expect(res.statusCode).toBe(301)
    expect(res.__headers()['location']).toBe(BEEHIIV_URL)
    expect(res.__body()).toBe('')
  })

  test('rejects other methods', async () => {
    const res = await get(TOKEN, ENV, 'POST')
    expect(res.statusCode).toBe(405)
  })
})

describe('feedMovedRss', () => {
  test('is well-formed RSS with a stable item', () => {
    const xml = feedMovedRss('https://ark.example')
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true)
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('<guid isPermaLink="false">ark-plus-feed-moved-2026-10</guid>')
    expect(xml).toContain('<itunes:block>Yes</itunes:block>')
    expect((xml.match(/<item>/g) ?? []).length).toBe(1)
  })

  test('escapes the base url', () => {
    expect(feedMovedRss('https://a.example/?x=1&y=2')).toContain('&amp;y=2')
  })
})
