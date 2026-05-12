// Unit tests for the entitlement sync. fetch is monkey-patched per test so
// neither Auth0 nor Circle is hit over the network. Tests focus on:
//   - subscriber/free flips PATCH the right Auth0 user and POST/DELETE the
//     right Circle tag
//   - missing-user / missing-member return no-op statuses (not errors)
//   - one downstream failing doesn't poison the other
//   - skipped status when env vars are absent

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import type Stripe from 'stripe'
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
  CIRCLE_COMMUNITY_ID: 'comm-1',
  CIRCLE_SUBSCRIBER_TAG_ID: 'tag-99',
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

beforeEach(() => {
  calls = []
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// Default routes: token + user-found + circle-found + tag-success.
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
    if (url.includes('/community_members/search')) {
      return jsonRes(200, { id: 7 })
    }
    if (url.includes('/community_members/7/tags/')) {
      return jsonRes(200, {})
    }
    return jsonRes(500, { unexpected: url })
  }
}

describe('syncEntitlement', () => {
  test('subscriber: PATCHes Auth0 with tier and POSTs Circle tag', async () => {
    installFetch(happyPath())
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res).toEqual({ email: 'a@x.com', tier: 'subscriber', auth0: 'ok', circle: 'ok' })

    const patch = calls.find((c) => c.init?.method === 'PATCH')
    expect(patch).toBeDefined()
    const patchBody = JSON.parse(String(patch!.init!.body))
    expect(patchBody.app_metadata.tier).toBe('subscriber')
    // No gift => gift_expires_at not set on subscriber upgrade.
    expect(patchBody.app_metadata.gift_expires_at).toBeUndefined()

    const tagCall = calls.find((c) => c.url.includes('/tags/tag-99'))
    expect(tagCall?.init?.method).toBe('POST')
  })

  test('free: PATCHes Auth0 with free and DELETEs Circle tag', async () => {
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

    const tagCall = calls.find((c) => c.url.includes('/tags/tag-99'))
    expect(tagCall?.init?.method).toBe('DELETE')
  })

  test('no Auth0 user yet → no-user (not an error)', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [])
      if (url.includes('/community_members/search')) return jsonRes(200, { id: 7 })
      if (init?.method === 'POST' || init?.method === 'DELETE') return jsonRes(200, {})
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('no-user')
    expect(res.circle).toBe('ok')
  })

  test('no Circle member yet → no-member (not an error)', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(200, [{ user_id: 'u1' }])
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (url.includes('/community_members/search')) return jsonRes(404, {})
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('ok')
    expect(res.circle).toBe('no-member')
  })

  test('Auth0 failure does not block Circle update', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) return jsonRes(500, { error: 'boom' })
      if (url.includes('/community_members/search')) return jsonRes(200, { id: 7 })
      if (url.includes('/community_members/7/tags/') && init?.method === 'POST') return jsonRes(200, {})
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
      if (url.includes('/community_members/search')) return jsonRes(500, { error: 'boom' })
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'subscriber')
    expect(res.auth0).toBe('ok')
    expect(res.circle).toBe('error')
  })

  test('skips Auth0 when mgmt creds absent', async () => {
    installFetch(({ url, init }) => {
      if (url.includes('/community_members/search')) return jsonRes(200, { id: 7 })
      if (init?.method === 'POST') return jsonRes(200, {})
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

  test('patches all Auth0 users for the email (multi-connection)', async () => {
    installFetch(({ url, init }) => {
      if (url.endsWith('/oauth/token')) return jsonRes(200, { access_token: 't', expires_in: 3600 })
      if (url.includes('/users-by-email')) {
        return jsonRes(200, [{ user_id: 'auth0|db' }, { user_id: 'google-oauth2|123' }])
      }
      if (url.includes('/api/v2/users/') && init?.method === 'PATCH') return jsonRes(200, {})
      if (url.includes('/community_members/search')) return jsonRes(200, { id: 7 })
      if (init?.method === 'POST') return jsonRes(200, {})
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

// Reconciler-specific fetch handler: serves Auth0 token + subscriber list +
// per-email PATCH + Circle search/tag/list.
type ReconcilerFixtures = {
  auth0Subscribers: Array<{
    email: string
    app_metadata?: { gift_expires_at?: string }
  }>
  // Circle members holding the subscriber tag. Defaults to []; pass a list to
  // exercise the drift pass.
  circleSubscribers?: string[]
  // When true, the Circle list endpoint returns 500 so the soft-fail path
  // runs.
  circleListFails?: boolean
}

function reconcilerFetchHandler(fixtures: ReconcilerFixtures): FetchHandler {
  const circleSubs = fixtures.circleSubscribers ?? []
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
    if (url.includes('/community_members/search')) {
      return jsonRes(200, { id: 7 })
    }
    if (url.includes('/community_members/7/tags/')) {
      return jsonRes(200, {})
    }
    if (url.includes('/community_members?')) {
      if (fixtures.circleListFails) {
        return jsonRes(500, { error: 'circle boom' })
      }
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '1')
      return jsonRes(
        200,
        page === 1 ? circleSubs.map((email) => ({ email })) : [],
      )
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
  // Auth0 may already read 'free' while Circle still holds the subscriber
  // tag (a partial-failure during a downgrade webhook). The Auth0-driven
  // downgrade pass misses those because they don't appear in its query;
  // the drift pass walks Circle and untags them.

  test('drift pass: Circle has tag but no active Stripe / no Auth0 → downgrade', async () => {
    installFetch(
      reconcilerFetchHandler({
        auth0Subscribers: [],
        circleSubscribers: ['drift@x.com'],
      }),
    )
    const stripe = makeStripe({ active: [[]], trialing: [[]] })

    const summary = await reconcileEntitlements(BASE_ENV, stripe)

    expect(summary.downgraded).toBe(1)
    // Email looked up to find member id 7, then untagged.
    const deleteTag = calls.find(
      (c) => c.url.includes('/community_members/7/tags/tag-99') && c.init?.method === 'DELETE',
    )
    expect(deleteTag).toBeDefined()
  })

  test('drift pass: Circle has tag but Stripe is active → no untag', async () => {
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
    const tagDeletes = calls.filter(
      (c) => c.url.includes('/tags/tag-99') && c.init?.method === 'DELETE',
    )
    expect(tagDeletes.length).toBe(0)
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

    // No Circle calls of any kind — token absence short-circuits the
    // listCircleSubscribers helper and setCircleTag.
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
      if (url.includes('/community_members/search')) {
        return jsonRes(200, { id: 7 })
      }
      if (url.includes('/community_members/7/tags/')) {
        return jsonRes(200, {})
      }
      if (url.includes('/community_members?')) {
        return jsonRes(200, [])
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
