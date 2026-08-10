// Unit tests for GET/PUT /api/account/profile, plus findOrCreateAuth0User's
// name handling — the provisioning-time half of the same story.
//
// The two live together because bun's mock.module is process-wide: a second file
// stubbing 'auth0' would race this one for the module binding and quietly break
// whichever lost. One stub, one file.
//
// The endpoint is the only place a member can give us their name, so the cases
// that matter are: it is guarded like every other cookie-authenticated mutation
// (same-origin, authenticated, rate-limited), it writes the shape Auth0 expects,
// it re-mints the session cookie so the greeting doesn't lag the edit, and — the
// one with real blast radius — a name we manufactured from the email reads as
// "needs a name" rather than a name we can greet someone by.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

// Captured Auth0 Management calls, and the user record the stub reports.
type Auth0User = {
  email: string
  given_name?: string
  family_name?: string
  app_metadata?: Record<string, unknown>
}
let auth0User: Auth0User | null = { email: 'member@x.com' }
let auth0Throws = false
let updates: { userId: string; body: Record<string, unknown> }[] = []
let updateRejects = false
// findOrCreateAuth0User's two calls: the by-email lookup and the create.
let byEmail: (Auth0User & { user_id?: string })[] = []
let creates: Record<string, unknown>[] = []

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
      listUsersByEmail: async () => byEmail,
      create: async (body: Record<string, unknown>) => {
        creates.push(body)
        return { user_id: 'auth0|new-1' }
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
import { findOrCreateAuth0User } from './lib/auth0-user'
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

// Supporting Cast is the third sink: its first_name is what the feed-setup
// reminder cron greets from, so a save that skips it keeps that email wrong.
let scCalls: BeehiivCall[] = []
let scHasUser = true

const originalFetch = globalThis.fetch
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.includes('api.supportingcast.fm')) {
    scCalls.push({ url, method: init?.method ?? 'GET', body: parseJsonInitBody(init) })
    if (url.endsWith('/users/search')) {
      return new Response(
        JSON.stringify(scHasUser ? { users: [{ id: 55, email: 'member@x.com' }] } : { users: [] }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }
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
  scCalls = []
  scHasUser = true
  byEmail = []
  creates = []
  sqlCalls.length = 0
})

afterAll(() => {
  globalThis.fetch = originalFetch
  // The 'auth0' stub above is process-wide and outlives this file, so anything
  // it would still report has to be emptied here. A leftover `byEmail` makes a
  // later suite's "Auth0 has no such user" case find one.
  byEmail = []
  creates = []
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
  opts: { cookie?: string; origin?: string; env?: Record<string, string> } = {},
): Promise<ReturnType<typeof makeRes>> {
  const cookie = opts.cookie ?? (await sessionCookie())
  const res = makeRes()
  await runHandler(
    buildHandler(opts.env),
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

  test('a name the member typed stays real even when it looks manufactured', async () => {
    // sarah@ typing "sarah" is character-for-character what we would have
    // manufactured for her. Without the app_metadata flag the save reads as junk
    // on this very next request and she is asked for her name all over again,
    // with the form seeded blank.
    auth0User = {
      email: 'sarah@gmail.com',
      given_name: 'sarah',
      app_metadata: { name_set_by_member: true },
    }
    const res = makeRes()
    await runHandler(
      buildHandler(),
      makeReq({ url: PATH, cookie: await sessionCookie() }),
      res,
    )
    expect(res.__json()).toEqual({
      givenName: 'sarah',
      familyName: null,
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

  test('rejects a bidi override, which can disguise one name as another', async () => {
    const res = await put({ given_name: 'Hannah\u202Ereversed' })
    expect(res.statusCode).toBe(400)
  })

  test('accepts the zero-width joiners real names are spelled with', async () => {
    // ZWNJ/ZWJ are \p{Cf} but orthographically required in Persian, Hindi,
    // Bengali and Malayalam. Rejecting the whole category 400s a valid name.
    const res = await put({ given_name: 'کاوه\u200Cنژاد' })
    expect(res.statusCode).toBe(200)
    expect(updates[0].body.given_name).toBe('کاوه\u200Cنژاد')
  })

  test('folds a pasted non-breaking space to a plain one', async () => {
    // U+00A0 is neither a control character nor an ASCII space, so it survived
    // the collapse and stored a name that never matches the same one typed out.
    const res = await put({ given_name: 'Hannah\u00A0Jane' })
    expect(res.statusCode).toBe(200)
    expect(updates[0].body.given_name).toBe('Hannah Jane')
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
      // Provenance: a name the member typed is never re-judged manufactured.
      app_metadata: { name_set_by_member: true },
    })
  })

  test('omits family_name entirely for a mononym — Auth0 400s on an empty one', async () => {
    // Auth0 validates the root name attributes as minLength 1, so sending
    // `family_name: ''` fails the whole write and the member is told to contact
    // support. The key has to be absent, not blank.
    const res = await put({ given_name: 'Prince' })
    expect(res.statusCode).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0].body).not.toHaveProperty('family_name')
    expect(updates[0].body.name).toBe('Prince')
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

  test('clearing a surname deletes the Beehiiv field rather than leaving the old one', async () => {
    // Skipping the empty part left "Waxman" on the record forever, so every
    // campaign merging {{first}} {{last}} kept sending the name they deleted.
    await put({ given_name: 'Hannah' })
    const write = beehiivCalls.find((c) => c.method === 'PUT')
    expect((write!.body as { custom_fields: unknown }).custom_fields).toEqual([
      { name: 'First Name', value: 'Hannah' },
      { name: 'Last Name', delete: true },
    ])
  })

  test('pushes the name to Supporting Cast — the reminder cron greets from it', async () => {
    const env = { ...BASE_ENV, SC_API_KEY: 'sc_test', SC_NETWORK_ID: 'net_1' }
    const res = await put({ given_name: 'Hannah', family_name: 'Waxman' }, { env })
    expect(res.statusCode).toBe(200)
    const write = scCalls.find((c) => c.method === 'PATCH')
    expect(write?.url).toContain('/users/55')
    expect(write?.body).toEqual({ first_name: 'Hannah', last_name: 'Waxman' })
  })

  test('an SC outage still returns 200 — the save landed in Auth0', async () => {
    const env = { ...BASE_ENV, SC_API_KEY: 'sc_test', SC_NETWORK_ID: 'net_1' }
    scHasUser = false
    const res = await put({ given_name: 'Hannah' }, { env })
    expect(res.statusCode).toBe(200)
    expect(scCalls.some((c) => c.method === 'PATCH')).toBe(false)
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

// ===========================================================================
// findOrCreateAuth0User — the name hint at provisioning time
//
// The hint (Stripe's customer.name at checkout, the recipient name on a gift) is
// the only name most members ever give us, and Auth0 is where it has to land.
// Two cases carry the weight: a brand-new account must not be stamped with a
// manufactured name, and an account that already exists must not swallow the
// hint silently — which is what left paying members being asked on this very
// page for a name they had already typed into checkout.
// ===========================================================================

const PROVISION_EMAIL = 'buyer@example.com'

// The gift path's flag; also keeps these off the change_password email, which
// goes through a different Auth0 client entirely.
const NO_RESET = { emailPasswordReset: false }

describe('new account', () => {
  test('writes the hint as given/family name', async () => {
    const res = await findOrCreateAuth0User(PROVISION_EMAIL, 'Hannah Waxman', BASE_ENV, NO_RESET)
    expect(res).toEqual({
      userId: 'auth0|new-1',
      created: true,
      passwordResetSent: false,
    })
    expect(creates[0]).toMatchObject({
      email: PROVISION_EMAIL,
      given_name: 'Hannah',
      family_name: 'Waxman',
    })
  })

  test('leaves the name unset when there is no hint', async () => {
    // Never fall back to the email local part: that is what filled the migrated
    // roster with members called "hannah.waxman8".
    await findOrCreateAuth0User(PROVISION_EMAIL, undefined, BASE_ENV, NO_RESET)
    expect(creates[0]).not.toHaveProperty('given_name')
    expect(creates[0]).not.toHaveProperty('family_name')
  })
})

describe('existing account', () => {
  test('fills an empty name from the hint', async () => {
    // The buyer typed their name into Stripe checkout. Before this, the hint was
    // read only on the create branch, so their existing login kept no name and
    // /account went on prompting them for one.
    byEmail = [{ user_id: 'auth0|existing', email: PROVISION_EMAIL }]
    const res = await findOrCreateAuth0User(PROVISION_EMAIL, 'Hannah Waxman', BASE_ENV, NO_RESET)
    expect(res?.created).toBe(false)
    expect(updates).toHaveLength(1)
    expect(updates[0].userId).toBe('auth0|existing')
    expect(updates[0].body).toMatchObject({
      given_name: 'Hannah',
      family_name: 'Waxman',
    })
  })

  test('replaces a name manufactured from the email address', async () => {
    byEmail = [
      { user_id: 'auth0|existing', email: PROVISION_EMAIL, given_name: 'buyer' },
    ]
    await findOrCreateAuth0User(PROVISION_EMAIL, 'Hannah Waxman', BASE_ENV, NO_RESET)
    expect(updates[0].body).toMatchObject({ given_name: 'Hannah' })
  })

  test('never overwrites a real name already on the record', async () => {
    byEmail = [
      {
        user_id: 'auth0|existing',
        email: PROVISION_EMAIL,
        given_name: 'Ada',
        family_name: 'Lovelace',
      },
    ]
    await findOrCreateAuth0User(PROVISION_EMAIL, 'Hannah Waxman', BASE_ENV, NO_RESET)
    expect(updates).toHaveLength(0)
  })

  test('never overwrites a name the member typed themselves', async () => {
    // "sarah" for sarah@… looks manufactured and is not; only the app_metadata
    // flag can tell, and a billing-form name must not win over it.
    byEmail = [
      {
        user_id: 'auth0|existing',
        email: 'sarah@gmail.com',
        given_name: 'sarah',
        app_metadata: { name_set_by_member: true },
      },
    ]
    await findOrCreateAuth0User('sarah@gmail.com', 'Sarah Smith', BASE_ENV, NO_RESET)
    expect(updates).toHaveLength(0)
  })

  test('does not flag the harvested name as member-supplied', async () => {
    // A name off a billing form is still a guess — it stays subject to the
    // manufactured-name heuristic, so it must not claim provenance.
    byEmail = [{ user_id: 'auth0|existing', email: PROVISION_EMAIL }]
    await findOrCreateAuth0User(PROVISION_EMAIL, 'Hannah Waxman', BASE_ENV, NO_RESET)
    expect(updates[0].body).not.toHaveProperty('app_metadata')
  })

  test('ignores a hint that is itself manufactured', async () => {
    byEmail = [{ user_id: 'auth0|existing', email: PROVISION_EMAIL }]
    await findOrCreateAuth0User(PROVISION_EMAIL, 'buyer', BASE_ENV, NO_RESET)
    expect(updates).toHaveLength(0)
  })

  test('a failed name write still returns the existing user', async () => {
    // Soft-fail: a name is not worth failing provisioning over.
    byEmail = [{ user_id: 'auth0|existing', email: PROVISION_EMAIL }]
    updateRejects = true
    const res = await findOrCreateAuth0User(PROVISION_EMAIL, 'Hannah Waxman', BASE_ENV, NO_RESET)
    expect(res).toEqual({
      userId: 'auth0|existing',
      created: false,
      passwordResetSent: false,
    })
  })
})
