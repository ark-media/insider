// Unit tests for the entitlement sync. fetch is monkey-patched per test so
// neither Auth0 nor Circle is hit over the network. Tests focus on:
//   - subscriber/free flips PATCH the right Auth0 user and POST/DELETE the
//     right Circle access group membership
//   - missing-user / missing-member return no-op statuses (not errors)
//   - one downstream failing doesn't poison the other
//   - skipped status when env vars are absent

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import type Stripe from 'stripe'
import { silenceExpectedConsole } from './test-utils'
import {
  emailForStripeCustomer,
  reconcileEntitlements,
  syncEntitlement,
} from './entitlement'

const BASE_ENV = {
  AUTH0_MANAGEMENT_CLIENT_ID: 'cid',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'csec',
  AUTH0_TENANT_DOMAIN: 'https://tenant.us.auth0.com',
  CIRCLE_API_TOKEN: 'circle-tok',
  CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: 'ag-99',
} as Record<string, string>

type FetchCall = { url: string; init?: RequestInit }
type FetchHandler = (call: FetchCall) => Response | Promise<Response>

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

function installFetch(handler: FetchHandler) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return Promise.resolve(handler({ url, init }))
  }) as typeof fetch
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

silenceExpectedConsole()

beforeEach(() => {
  calls = []
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// Default routes: token + user-found + access-group POST/DELETE success.
function happyPath(): FetchHandler {
  return ({ url, init }) => {
    if (url.endsWith('/oauth/token')) {
      return jsonRes(200, { access_token: 'mgmt-tok', expires_in: 3600 })
    }
    if (url.includes('/users-by-email')) {
      return jsonRes(200, [{ user_id: 'auth0|abc' }])
    }
    if (url.includes('/api/v2/users/') && init?.method === 'PATCH') {
      return jsonRes(200, {})
    }
    if (url.includes('/access_groups/ag-99/community_members')) {
      return jsonRes(200, {})
    }
    return jsonRes(500, { unexpected: url })
  }
}

describe('syncEntitlement', () => {
  test('subscriber: PATCHes Auth0 with tier and POSTs Circle access group', async () => {
    installFetch(happyPath())
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res).toEqual({ email: 'a@x.com', tier: 'subscriber', auth0: 'ok', circle: 'ok' })

    const patch = calls.find((c) => c.init?.method === 'PATCH')
    expect(patch).toBeDefined()
    const patchBody = JSON.parse(String(patch!.init!.body))
    expect(patchBody.app_metadata.tier).toBe('subscriber')
    // No gift => gift_expires_at not set on subscriber upgrade.
    expect(patchBody.app_metadata.gift_expires_at).toBeUndefined()

    const agCall = calls.find((c) =>
      c.url.includes('/access_groups/ag-99/community_members'),
    )
    expect(agCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(agCall!.init!.body))).toEqual({ email: 'a@x.com' })
  })

  test('free: PATCHes Auth0 with free and DELETEs Circle access group', async () => {
    installFetch(happyPath())
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'free')
    expect(res.auth0).toBe('ok')
    expect(res.circle).toBe('ok')

    const patchBody = JSON.parse(
      String(calls.find((c) => c.init?.method === 'PATCH')!.init!.body),
    )
    expect(patchBody.app_metadata.tier).toBe('free')
    // Downgrade clears any prior gift state.
    expect(patchBody.app_metadata.gift_expires_at).toBeNull()

    const agCall = calls.find((c) =>
      c.url.includes('/access_groups/ag-99/community_members'),
    )
    expect(agCall?.init?.method).toBe('DELETE')
    // DELETE puts the email in the query string.
    expect(agCall!.url).toContain('email=a%40x.com')
  })

  test('no Auth0 user yet → no-user (not an error)', async () => {
    installFetch(({ url }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [])
      if (url.includes('/access_groups/ag-99/community_members')) {
        return jsonRes(200, {})
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('no-user')
    expect(res.circle).toBe('ok')
  })

  test('no Circle community member (POST returns 404) → no-member', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (url.includes('/access_groups/ag-99/community_members')) {
        return jsonRes(404, { error: 'no member' })
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('ok')
    expect(res.circle).toBe('no-member')
  })

  test('POST when email is already in the group (422) is treated as success', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (
        url.includes('/access_groups/ag-99/community_members') &&
        init?.method === 'POST'
      ) {
        return jsonRes(422, { error: 'already a member' })
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.circle).toBe('ok')
  })

  test('POST when email is already in the group (409) is treated as success', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (
        url.includes('/access_groups/ag-99/community_members') &&
        init?.method === 'POST'
      ) {
        return jsonRes(409, { error: 'conflict' })
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.circle).toBe('ok')
  })

  test('POST 403 (auth failure) propagates as circle:error', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (
        url.includes('/access_groups/ag-99/community_members') &&
        init?.method === 'POST'
      ) {
        return jsonRes(403, { error: 'wrong token type' })
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.circle).toBe('error')
  })

  test('DELETE on a member who is not in the group (404) is treated as success', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (
        url.includes('/access_groups/ag-99/community_members') &&
        init?.method === 'DELETE'
      ) {
        return jsonRes(404, { error: 'not in group' })
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'free')
    expect(res.circle).toBe('ok')
  })

  test('Auth0 failure does not block Circle update', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(500, { error: 'boom' })
      if (
        url.includes('/access_groups/ag-99/community_members') &&
        init?.method === 'POST'
      ) {
        return jsonRes(200, {})
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('error')
    expect(res.circle).toBe('ok')
  })

  test('Circle failure does not block Auth0 update', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (url.includes('/access_groups/ag-99/community_members')) {
        return jsonRes(500, { error: 'boom' })
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('ok')
    expect(res.circle).toBe('error')
  })

  test('skips Auth0 when mgmt creds absent', async () => {
    installFetch(({ url }) => {
      if (url.includes('/access_groups/ag-99/community_members')) {
        return jsonRes(200, {})
      }
      return jsonRes(500, { unexpected: url })
    })
    const env = { ...BASE_ENV, AUTH0_MANAGEMENT_CLIENT_ID: '', AUTH0_MANAGEMENT_CLIENT_SECRET: '' }
    const res = await syncEntitlement(env, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('skipped')
    expect(res.circle).toBe('ok')
    // No token fetch should have happened.
    expect(calls.find((c) => c.url.endsWith('/oauth/token'))).toBeUndefined()
  })

  test('skips Circle when token absent', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      return jsonRes(500, { unexpected: url })
    })
    const env = { ...BASE_ENV, CIRCLE_API_TOKEN: '' }
    const res = await syncEntitlement(env, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('ok')
    expect(res.circle).toBe('skipped')
  })

  test('skips Circle when access group id absent', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      return jsonRes(500, { unexpected: url })
    })
    const env = { ...BASE_ENV, CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: '' }
    const res = await syncEntitlement(env, 'a@x.com', 'subscriber')
    expect(res.circle).toBe('skipped')
  })

  test('patches all Auth0 users for the email (multi-connection)', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) {
        return jsonRes(200, [{ user_id: 'auth0|db' }, { user_id: 'google-oauth2|123' }])
      }
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (url.includes('/access_groups/ag-99/community_members')) return jsonRes(200, {})
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('ok')
    const patches = calls.filter((c) => c.init?.method === 'PATCH')
    expect(patches.length).toBe(2)
  })

  test('gift: subscriber with giftExpiresAt writes the date to Auth0', async () => {
    installFetch(happyPath())
    const expires = '2027-01-01T00:00:00.000Z'
    await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber', { giftExpiresAt: expires })
    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    const body = JSON.parse(String(patch.init!.body))
    expect(body.app_metadata.tier).toBe('subscriber')
    expect(body.app_metadata.gift_expires_at).toBe(expires)
  })
})

// --- emailForStripeCustomer -------------------------------------------------

describe('emailForStripeCustomer', () => {
  test('returns email from an expanded Customer object', async () => {
    const stripe = {} as Stripe
    const c = { id: 'cus_1', email: 'a@x.com' } as unknown as Stripe.Customer
    expect(await emailForStripeCustomer(c, stripe)).toBe('a@x.com')
  })

  test('returns null for a DeletedCustomer', async () => {
    const stripe = {} as Stripe
    const c = { id: 'cus_1', deleted: true } as unknown as Stripe.DeletedCustomer
    expect(await emailForStripeCustomer(c, stripe)).toBeNull()
  })

  test('retrieves Customer by id when given a string', async () => {
    let retrievedWith: string | undefined
    const stripe = {
      customers: {
        retrieve: async (id: string) => {
          retrievedWith = id
          return { id, email: 'b@x.com', deleted: false }
        },
      },
    } as unknown as Stripe
    const out = await emailForStripeCustomer('cus_2', stripe)
    expect(out).toBe('b@x.com')
    expect(retrievedWith).toBe('cus_2')
  })

  test('returns null for null input', async () => {
    const stripe = {} as Stripe
    expect(await emailForStripeCustomer(null, stripe)).toBeNull()
  })
})

// --- reconcileEntitlements --------------------------------------------------

type FakeSub = {
  id: string
  status: Stripe.Subscription.Status
  customer: { id: string; email: string }
}

function makeStripe(
  pages: Record<'active' | 'trialing', FakeSub[][]>,
): Stripe {
  // subscriptions.list paginates by status. Each call returns one page; we
  // pop in order. has_more = there's another page in the queue.
  const queues = {
    active: pages.active.map((data) => ({ data, has_more: false })),
    trialing: pages.trialing.map((data) => ({ data, has_more: false })),
  }
  // Mark has_more on all-but-last for each status.
  for (const status of ['active', 'trialing'] as const) {
    for (let i = 0; i < queues[status].length - 1; i += 1) {
      queues[status][i].has_more = true
    }
  }
  return {
    subscriptions: {
      list: async (opts: { status: 'active' | 'trialing' }) => {
        const next = queues[opts.status].shift()
        return next ?? { data: [], has_more: false }
      },
    },
  } as unknown as Stripe
}

// Reconciler-specific fetch handler: Auth0 token + subscriber list + per-email
// PATCH + Circle access-group POST/DELETE + drift-pass list endpoints.
type ReconcilerFixtures = {
  auth0Subscribers: Array<{
    email: string
    app_metadata?: { gift_expires_at?: string }
  }>
  // Emails currently in the subscriber access group on Circle. Defaults to
  // []; pass a list to exercise the drift pass.
  circleSubscribers?: string[]
  // When true, the access-group list endpoint returns 500 so the soft-fail
  // path runs.
  circleListFails?: boolean
}

function reconcilerFetchHandler(fixtures: ReconcilerFixtures): FetchHandler {
  const circleSubs = fixtures.circleSubscribers ?? []
  // Assign each circle subscriber a deterministic community_member_id so
  // the access-group list and the community-members list can be joined.
  const memberIdForEmail = new Map(
    circleSubs.map((email, idx) => [email, idx + 1] as const),
  )
  return ({ url, init }) => {
    if (url.endsWith('/oauth/token')) {
      return jsonRes(200, { access_token: 'mgmt-tok', expires_in: 3600 })
    }
    if (url.includes('/users-by-email')) {
      const email = decodeURIComponent(url.split('email=')[1]!.split('&')[0]!)
      return jsonRes(200, [{ user_id: `auth0|${email}` }])
    }
    if (url.includes('/api/v2/users?')) {
      // Subscriber-list paging — return everything on page 0, empty on page 1+.
      // Anchor on `[?&]page=` so `per_page=100` doesn't accidentally match.
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '0')
      return jsonRes(200, page === 0 ? fixtures.auth0Subscribers : [])
    }
    if (url.includes('/api/v2/users/') && init?.method === 'PATCH') {
      return jsonRes(200, {})
    }
    // Order matters: the access-group list (path includes /access_groups/)
    // must match before the generic /community_members fallback.
    if (url.includes('/access_groups/ag-99/community_members')) {
      // POST and DELETE both go here too; succeed quietly for those.
      if (init?.method === 'POST' || init?.method === 'DELETE') {
        return jsonRes(200, {})
      }
      // GET — list of members in the group.
      if (fixtures.circleListFails) {
        return jsonRes(500, { error: 'circle boom' })
      }
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '1')
      const records =
        page === 1
          ? circleSubs.map((email) => ({
              community_member_id: memberIdForEmail.get(email)!,
            }))
          : []
      return jsonRes(200, { records, has_next_page: false })
    }
    if (url.includes('/community_members')) {
      // Full members list used by the drift pass to resolve ids → emails.
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '1')
      const records =
        page === 1
          ? circleSubs.map((email) => ({
              id: memberIdForEmail.get(email)!,
              email,
            }))
          : []
      return jsonRes(200, { records, has_next_page: false })
    }
    return jsonRes(500, { unexpected: url })
  }
}

describe('reconcileEntitlements', () => {
  test('upgrade pass: active Stripe sub flips Auth0 + Circle to subscriber', async () => {
    installFetch(reconcilerFetchHandler({ auth0Subscribers: [] }))
    const stripe = makeStripe({
      active: [[{ id: 's_1', status: 'active', customer: { id: 'c_1', email: 'A@X.com' } }]],
      trialing: [[]],
    })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.upgraded).toBe(1)
    expect(summary.downgraded).toBe(0)
    expect(summary.errors).toBe(0)

    // Email lowercased before downstream calls.
    const patches = calls.filter((c) => c.init?.method === 'PATCH')
    expect(patches.length).toBe(1)
    const body = JSON.parse(String(patches[0]!.init!.body))
    expect(body.app_metadata.tier).toBe('subscriber')
  })

  test('downgrade pass: Auth0 subscriber with no active Stripe sub flips to free', async () => {
    installFetch(reconcilerFetchHandler({ auth0Subscribers: [{ email: 'stale@x.com' }] }))
    const stripe = makeStripe({ active: [[]], trialing: [[]] })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.upgraded).toBe(0)
    expect(summary.downgraded).toBe(1)
    expect(summary.errors).toBe(0)
    const downgradePatch = calls.find(
      (c) => c.init?.method === 'PATCH' && String(c.init.body).includes('"tier":"free"'),
    )
    expect(downgradePatch).toBeDefined()
    const body = JSON.parse(String(downgradePatch!.init!.body))
    expect(body.app_metadata.gift_expires_at).toBeNull()
  })

  test('downgrade pass: gift with future expiry is preserved', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [
          { email: 'gifted@x.com', app_metadata: { gift_expires_at: future } },
        ],
      }),
    )
    const stripe = makeStripe({ active: [[]], trialing: [[]] })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.downgraded).toBe(0)
    const downgradePatches = calls.filter(
      (c) => c.init?.method === 'PATCH' && String(c.init.body).includes('"tier":"free"'),
    )
    expect(downgradePatches.length).toBe(0)
  })

  test('downgrade pass: gift with past expiry is downgraded', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [
          { email: 'expired@x.com', app_metadata: { gift_expires_at: past } },
        ],
      }),
    )
    const stripe = makeStripe({ active: [[]], trialing: [[]] })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.downgraded).toBe(1)
  })

  test('user with both active sub and stale Auth0 entry is not double-counted as downgrade', async () => {
    installFetch(
      reconcilerFetchHandler({ auth0Subscribers: [{ email: 'both@x.com' }] }),
    )
    const stripe = makeStripe({
      active: [[{ id: 's_1', status: 'active', customer: { id: 'c_1', email: 'both@x.com' } }]],
      trialing: [[]],
    })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.upgraded).toBe(1)
    expect(summary.downgraded).toBe(0)
  })

  test('trialing subs count as subscribers', async () => {
    installFetch(reconcilerFetchHandler({ auth0Subscribers: [] }))
    const stripe = makeStripe({
      active: [[]],
      trialing: [[{ id: 's_t', status: 'trialing', customer: { id: 'c_t', email: 't@x.com' } }]],
    })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.upgraded).toBe(1)
  })

  // --- Circle drift pass --------------------------------------------------
  // Auth0 may already read 'free' while Circle still has the user in the
  // subscriber access group (a partial-failure during a downgrade webhook).
  // The Auth0-driven downgrade pass misses those because they don't appear
  // in its query; the drift pass walks Circle and removes them.

  test('drift pass: Circle has group member with no active Stripe / no Auth0 → remove', async () => {
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [],
        circleSubscribers: ['drift@x.com'],
      }),
    )
    const stripe = makeStripe({ active: [[]], trialing: [[]] })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.downgraded).toBe(1)
    // The drift email is removed from the access group via DELETE.
    const removal = calls.find(
      (c) =>
        c.url.includes('/access_groups/ag-99/community_members') &&
        c.url.includes('email=drift%40x.com') &&
        c.init?.method === 'DELETE',
    )
    expect(removal).toBeDefined()
  })

  test('drift pass: group member with active Stripe → no removal', async () => {
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [],
        circleSubscribers: ['paying@x.com'],
      }),
    )
    const stripe = makeStripe({
      active: [[{ id: 's_p', status: 'active', customer: { id: 'c_p', email: 'paying@x.com' } }]],
      trialing: [[]],
    })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.upgraded).toBe(1)
    expect(summary.downgraded).toBe(0)
    const deletes = calls.filter(
      (c) =>
        c.url.includes('/access_groups/ag-99/community_members') &&
        c.init?.method === 'DELETE',
    )
    expect(deletes.length).toBe(0)
  })

  test('drift pass: list endpoint failure does not fail the run', async () => {
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [],
        circleSubscribers: ['ghost@x.com'],
        circleListFails: true,
      }),
    )
    const stripe = makeStripe({ active: [[]], trialing: [[]] })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.errors).toBe(0)
    expect(summary.downgraded).toBe(0)
  })

  test('drift pass: skipped when CIRCLE_API_TOKEN is unset', async () => {
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [],
        circleSubscribers: ['unused@x.com'],
      }),
    )
    const stripe = makeStripe({ active: [[]], trialing: [[]] })
    const env = { ...BASE_ENV, CIRCLE_API_TOKEN: '' }

    await reconcileEntitlements(env, stripe)

    // No Circle calls of any kind — token absence short-circuits both the
    // list helper and setCircleAccessGroup.
    const circleCalls = calls.filter((c) => c.url.includes('circle.so'))
    expect(circleCalls.length).toBe(0)
  })

  test('drift pass: not double-processed when downgrade pass already covers the email', async () => {
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [{ email: 'shared@x.com' }],
        circleSubscribers: ['shared@x.com'],
      }),
    )
    const stripe = makeStripe({ active: [[]], trialing: [[]] })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    // Auth0 downgrade pass picks them up; drift pass must not re-process.
    expect(summary.downgraded).toBe(1)
  })
})

// --- Auth0 export-job fallback ---------------------------------------------
// When the search-based list saturates (each of maxPages pages returns 100),
// listAuth0Subscribers switches to /jobs/users-exports. The job is created,
// polled until status:'completed', and its result URL is fetched and
// gunzipped.

describe('listAuth0Subscribers export-job fallback', () => {
  test('falls back to export when search-list saturates the page budget', async () => {
    // Pre-build a gzipped NDJSON payload of one subscriber + one free user.
    const { gzipSync } = await import('node:zlib')
    const ndjson =
      JSON.stringify({
        email: 'paid@x.com',
        app_metadata: { tier: 'subscriber', gift_expires_at: '2099-01-01' },
      }) +
      '\n' +
      JSON.stringify({ email: 'free@x.com', app_metadata: { tier: 'free' } }) +
      '\n'
    const gz = gzipSync(Buffer.from(ndjson, 'utf8'))

    let exportCreateCount = 0
    let exportPollCount = 0
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) {
        return jsonRes(200, { access_token: 'mgmt-tok', expires_in: 3600 })
      }
      if (url.endsWith('/jobs/users-exports') && init?.method === 'POST') {
        exportCreateCount += 1
        return jsonRes(201, { id: 'job_abc', status: 'pending' })
      }
      if (url.includes('/jobs/job_abc')) {
        exportPollCount += 1
        // First poll: pending. Second: completed with a download URL.
        if (exportPollCount < 2) {
          return jsonRes(200, { id: 'job_abc', status: 'pending' })
        }
        return jsonRes(200, {
          id: 'job_abc',
          status: 'completed',
          location: 'https://export-results.example/abc.gz',
        })
      }
      if (url.startsWith('https://export-results.example/')) {
        return new Response(gz, {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        })
      }
      if (url.includes('/api/v2/users?')) {
        // Always-full pages → forces saturation of the search path.
        const auth0Subscribers = Array.from({ length: 100 }, (_, i) => ({
          email: `bulk${i}@x.com`,
        }))
        return jsonRes(200, auth0Subscribers)
      }
      if (url.includes('/users-by-email')) {
        return jsonRes(200, [{ user_id: 'auth0|u' }])
      }
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') {
        return jsonRes(200, {})
      }
      if (url.includes('/access_groups/ag-99/community_members')) {
        if (init?.method === 'POST' || init?.method === 'DELETE') return jsonRes(200, {})
        return jsonRes(200, { records: [], has_next_page: false })
      }
      if (url.includes('/community_members')) {
        return jsonRes(200, { records: [], has_next_page: false })
      }
      return jsonRes(500, { unexpected: url })
    })

    const stripe = makeStripe({ active: [[]], trialing: [[]] })
    // maxAuth0Pages=2 keeps the fixture small; the 100-per-page response on
    // both pages still triggers saturation.
    const summary = await reconcileEntitlements(BASE_ENV, stripe, {
      maxAuth0Pages: 2,
    })

    expect(exportCreateCount).toBe(1)
    expect(exportPollCount).toBeGreaterThanOrEqual(2)
    // Only the subscriber-tier row from the gzip body should be processed.
    // The 200 bulk users from the search path are discarded once we fall
    // back, so the downgrade pass sees just the single 'paid@x.com' row,
    // which has a future gift and is therefore protected.
    expect(summary.downgraded).toBe(0)
  }, 30_000)
})
