// Unit tests for GET/PUT /api/account/profile.
//
// The endpoint is the only place a member can give us their name, so the cases
// that matter are: it is guarded like every other cookie-authenticated mutation
// (same-origin, authenticated, rate-limited), it writes the shape Auth0 expects,
// it re-mints the session cookie so the greeting doesn't lag the edit, and — the
// one with real blast radius — a name we manufactured from the email reads as
// "needs a name" rather than a name we can greet someone by.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

// Captured Auth0 Management calls, and the user record the stub reports.
type Auth0User = { email: string; given_name?: string; family_name?: string }
let auth0User: Auth0User | null = { email: 'member@x.com' }
let auth0Throws = false
let updates: { userId: string; body: Record<string, unknown> }[] = []
let updateRejects = false

mock.module('auth0', () => ({
  ManagementClient: class {
    users = {
      get: async () => {
        if (auth0Throws) throw new Error('auth0 unavailable')
        return auth0User
      },
      update: async (userId: string, body: Record<string, unknown>) => {
        if (updateRejects) throw new Error('400 root attributes are read-only')
        updates.push({ userId, body })
        return { ...auth0User, ...body }
      },
    }
  },
  AuthenticationClient: class {},
  __esModule: true,
}))

import {
  neonMockModule,
  type SqlCall,
  createDevApiHarness,
  makeFakeReq as makeReq,
  makeFakeRes as makeRes,
  parseJsonInitBody,
  runMiddleware as runHandler,
  silenceExpectedConsole,
  type Middleware,
} from './test-utils'

const sqlCalls: SqlCall[] = []
mock.module('@neondatabase/serverless', () => neonMockModule(sqlCalls, () => []))

import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'

const PATH = '/api/account/profile'
const ORIGIN = 'http://localhost:5173'
const SUB = 'auth0|member-1'
const PUB_ID = 'pub_test-profile'

const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: ORIGIN,
  SESSION_SECRET: 'session-secret-for-tests-32-chars__',
  AUTH0_MANAGEMENT_CLIENT_ID: 'mgmt-client',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'mgmt-secret',
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: PUB_ID,
  DATABASE_URL: 'postgres://stub-account-profile-test',
}

function buildHandler(env: Record<string, string> = BASE_ENV): Middleware {
  return createDevApiHarness(devApiPlugin(env)).getHandler(PATH)
}

// Beehiiv calls the name push makes, so the fan-out can be asserted.
type BeehiivCall = { url: string; method: string; body: unknown }
let beehiivCalls: BeehiivCall[] = []
let beehiivHasSubscriber = true

const originalFetch = globalThis.fetch
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.includes('api.beehiiv.com')) {
    beehiivCalls.push({ url, method: init?.method ?? 'GET', body: parseJsonInitBody(init) })
    if (url.includes('/by_email/')) {
      if (!beehiivHasSubscriber) return new Response('{}', { status: 404 })
      return new Response(
        JSON.stringify({
          data: { id: 'sub_1', email: 'member@x.com', status: 'active' },
        }),
        { status: 200 },
      )
    }
    return new Response(
      JSON.stringify({
        data: { id: 'sub_1', email: 'member@x.com', status: 'active' },
      }),
      { status: 200 },
    )
  }
  return new Response('{}', { status: 500 })
}) as typeof fetch

silenceExpectedConsole()

beforeEach(() => {
  auth0User = { email: 'member@x.com' }
  auth0Throws = false
  updateRejects = false
  updates = []
  beehiivCalls = []
  beehiivHasSubscriber = true
  sqlCalls.length = 0
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// The rate limiters live at module scope and are keyed on the Auth0 sub, so
// tests must not share one or later cases inherit earlier cases' spent buckets.
// Every request gets a fresh sub unless it is deliberately reusing a cookie.
let subCounter = 0
function freshSub(): string {
  return `${SUB}-${++subCounter}`
}

async function sessionCookie(
  extra: { sub?: string; givenName?: string; familyName?: string } = {},
): Promise<string> {
  const token = await signSessionToken(
    { email: 'member@x.com', roles: [], sub: freshSub(), ...extra },
    BASE_ENV,
  )
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function put(
  body: unknown,
  opts: { cookie?: string; origin?: string } = {},
): Promise<ReturnType<typeof makeRes>> {
  const cookie = opts.cookie ?? (await sessionCookie())
  const res = makeRes()
  await runHandler(
    buildHandler(),
    makeReq({
      method: 'PUT',
      url: PATH,
      cookie,
      body,
      headers: { origin: opts.origin ?? ORIGIN },
    }),
    res,
  )
  return res
}

describe('auth and CSRF', () => {
  test('401 without a session', async () => {
    const res = makeRes()
    await runHandler(buildHandler(), makeReq({ url: PATH }), res)
    expect(res.statusCode).toBe(401)
  })

  test('403 on a cross-origin write', async () => {
    const res = await put({ given_name: 'Hannah' }, { origin: 'https://evil.example' })
    expect(res.statusCode).toBe(403)
    expect((res.__json() as { error: string }).error).toBe('bad_origin')
    expect(updates).toHaveLength(0)
  })

  test('401 for a session with no Auth0 sub — nothing to read or write', async () => {
    const token = await signSessionToken(
      { email: 'member@x.com', roles: [], sub: undefined },
      BASE_ENV,
    )
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({ url: PATH, cookie: `${SESSION_COOKIE_NAME}=${token}` }),
      res,
    )
    expect(res.statusCode).toBe(401)
  })

  test('405 on an unsupported method', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({ method: 'DELETE', url: PATH, cookie: await sessionCookie() }),
      res,
    )
    expect(res.statusCode).toBe(405)
  })
})

describe('GET', () => {
  test('reports needsName for a name manufactured from the email', async () => {
    auth0User = { email: 'hannah.waxman8@x.com', given_name: 'hannah.waxman8' }
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({ url: PATH, cookie: await sessionCookie() }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      givenName: 'hannah.waxman8',
      familyName: null,
      needsName: true,
    })
  })

  test('reports a real name as complete', async () => {
    auth0User = { email: 'member@x.com', given_name: 'Hannah', family_name: 'Waxman' }
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({ url: PATH, cookie: await sessionCookie() }),
      res,
    )
    expect(res.__json()).toEqual({
      givenName: 'Hannah',
      familyName: 'Waxman',
      needsName: false,
    })
  })

  test('never caches — the answer changes the moment the member saves', async () => {
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({ url: PATH, cookie: await sessionCookie() }),
      res,
    )
    expect(res.getHeader('cache-control')).toBe('private, no-store')
  })

  test('502 when the Management API is unavailable', async () => {
    auth0Throws = true
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({ url: PATH, cookie: await sessionCookie() }),
      res,
    )
    expect(res.statusCode).toBe(502)
    expect((res.__json() as { error: string }).error).toBe('profile_unavailable')
  })
})

describe('PUT validation', () => {
  test('rejects a missing or blank first name', async () => {
    expect((await put({})).statusCode).toBe(400)
    expect((await put({ given_name: '   ' })).statusCode).toBe(400)
    expect((await put({ given_name: 'Hannah', family_name: 42 })).statusCode).toBe(400)
    expect(updates).toHaveLength(0)
  })

  test('rejects an over-length part', async () => {
    const res = await put({ given_name: 'a'.repeat(41) })
    expect(res.statusCode).toBe(400)
  })

  test('rejects control characters that would corrupt a mail header', async () => {
    const res = await put({ given_name: 'Hannah\nBcc: someone@else.com' })
    expect(res.statusCode).toBe(400)
  })

  test('accepts a mononym — a surname is optional', async () => {
    const res = await put({ given_name: 'Prince' })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({
      givenName: 'Prince',
      familyName: null,
      needsName: false,
    })
  })
})

describe('PUT effects', () => {
  test('writes given/family/name to the Auth0 user', async () => {
    const sub = freshSub()
    const cookie = await sessionCookie({ sub })
    const res = await put({ given_name: '  Hannah ', family_name: 'Waxman' }, { cookie })
    expect(res.statusCode).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0].userId).toBe(sub)
    expect(updates[0].body).toEqual({
      given_name: 'Hannah',
      family_name: 'Waxman',
      name: 'Hannah Waxman',
    })
  })

  test('re-mints the session cookie so the greeting updates without a re-login', async () => {
    const res = await put({ given_name: 'Hannah', family_name: 'Waxman' })
    const setCookie = res.getHeader('set-cookie')
    const header = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie)
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`)
  })

  test('pushes the name to Beehiiv as custom fields', async () => {
    await put({ given_name: 'Hannah', family_name: 'Waxman' })
    const write = beehiivCalls.find((c) => c.method === 'PUT')
    expect(write).toBeDefined()
    expect((write!.body as { custom_fields: unknown }).custom_fields).toEqual([
      { name: 'First Name', value: 'Hannah' },
      { name: 'Last Name', value: 'Waxman' },
    ])
  })

  test('a reader with no Beehiiv record is left alone — a name is not a reason to subscribe them', async () => {
    beehiivHasSubscriber = false
    const res = await put({ given_name: 'Hannah' })
    expect(res.statusCode).toBe(200)
    expect(beehiivCalls.some((c) => c.method === 'PUT')).toBe(false)
  })

  test('a Beehiiv outage still returns 200 — the save landed in Auth0', async () => {
    const saved = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('beehiiv down')
    }) as unknown as typeof fetch
    try {
      const res = await put({ given_name: 'Hannah' })
      expect(res.statusCode).toBe(200)
      expect(updates).toHaveLength(1)
    } finally {
      globalThis.fetch = saved
    }
  })

  test('502 when Auth0 refuses the write, rather than claiming a save', async () => {
    updateRejects = true
    const res = await put({ given_name: 'Hannah' })
    expect(res.statusCode).toBe(502)
    expect((res.__json() as { error: string }).error).toBe('profile_not_writable')
    expect(res.getHeader('set-cookie')).toBeUndefined()
  })
})

describe('rate limiting', () => {
  test('429s a caller hammering saves', async () => {
    const cookie = await sessionCookie()
    let last = 0
    for (let i = 0; i < 12; i++) {
      const res = await put({ given_name: 'Hannah' }, { cookie })
      last = res.statusCode
    }
    expect(last).toBe(429)
  })
})
