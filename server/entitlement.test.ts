// Unit tests for the entitlement module. fetch is monkey-patched per test so
// no Circle / SC call leaves the process; Neon is a mocked tagged-template.
//
//   - syncEntitlement now syncs ONLY the Circle axis (Auth0 holds no
//     entitlement, task 5): a tier that grants circle POSTs the access group,
//     one that doesn't DELETEs it. No Auth0 PATCH.
//   - reconcileEntitlements is Neon-authoritative + removal-only (task 15): it
//     diffs the Neon roster against the SC roster (arkPlus, on sc_user_id) and
//     the Circle access group (circle, on the stamped auth0_sub), removing drift.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import type Stripe from 'stripe'
import { silenceExpectedConsole } from './test-utils'

// --- Neon mock (staged membership roster for the reconciler) ----------------
let neonMembershipRows: unknown[] = []
mock.module('@neondatabase/serverless', () => ({
  neon:
    (_url: string) =>
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const merged = strings.join('?')
      if (merged.includes('from membership')) {
        return Promise.resolve(neonMembershipRows)
      }
      // Everything else (beehiiv mirror reads/writes during drift downgrade) → [].
      return Promise.resolve([])
    },
  __esModule: true,
}))

// Imports AFTER mock.module so getDb picks up the fake neon.
import {
  deriveEntitlements,
  emailForStripeCustomer,
  reconcileEntitlements,
  syncEntitlement,
} from './entitlement'
import { requiresAgeGate } from '../shared/age-gate'
import type { Tier } from './entitlement'

const BASE_ENV = {
  CIRCLE_API_TOKEN: 'circle-tok',
  CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: 'ag-99',
  SC_API_KEY: 'sc-key',
  SC_NETWORK_ID: 'net-1',
  DATABASE_URL: 'postgres://stub-entitlement-test',
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
  neonMembershipRows = []
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// --- syncEntitlement (Circle axis only) -------------------------------------

describe('syncEntitlement', () => {
  test('circle-granting tier POSTs the access group', async () => {
    installFetch(({ url }) => {
      if (url.includes('/access_groups/ag-99/community_members')) return jsonRes(200, {})
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'bundle')
    expect(res).toEqual({
      email: 'a@x.com',
      tier: 'bundle',
      entitlements: { arkPlus: true, circle: true },
      circle: 'ok',
    })
    // No Auth0 PATCH — Auth0 holds no entitlement.
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false)
    const agCall = calls.find((c) =>
      c.url.includes('/access_groups/ag-99/community_members'),
    )
    expect(agCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(agCall!.init!.body))).toEqual({ email: 'a@x.com' })
  })

  test('a tier without circle DELETEs the access group', async () => {
    installFetch(({ url }) => {
      if (url.includes('/access_groups/ag-99/community_members')) return jsonRes(200, {})
      return jsonRes(500, { unexpected: url })
    })
    // ark-plus grants arkPlus but NOT circle → remove from the Circle group.
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'ark-plus')
    expect(res.tier).toBe('ark-plus')
    expect(res.circle).toBe('ok')
    const agCall = calls.find((c) =>
      c.url.includes('/access_groups/ag-99/community_members'),
    )
    expect(agCall?.init?.method).toBe('DELETE')
    expect(agCall!.url).toContain('email=a%40x.com')
  })

  test('POST 404 (not a Circle member yet) → no-member', async () => {
    installFetch(({ url }) => {
      if (url.includes('/access_groups/ag-99/community_members')) return jsonRes(404, {})
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'circle')
    expect(res.circle).toBe('no-member')
  })

  test('POST 422 / 409 (already in group) → ok', async () => {
    for (const status of [422, 409]) {
      calls = []
      installFetch(({ url, init }) => {
        if (url.includes('/access_groups/ag-99/community_members') && init?.method === 'POST') {
          return jsonRes(status, {})
        }
        return jsonRes(500, { unexpected: url })
      })
      const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'circle')
      expect(res.circle).toBe('ok')
    }
  })

  test('POST 403 (auth failure) → circle:error', async () => {
    installFetch(({ url, init }) => {
      if (url.includes('/access_groups/ag-99/community_members') && init?.method === 'POST') {
        return jsonRes(403, {})
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'circle')
    expect(res.circle).toBe('error')
  })

  test('DELETE 404 (not in group) → ok', async () => {
    installFetch(({ url, init }) => {
      if (url.includes('/access_groups/ag-99/community_members') && init?.method === 'DELETE') {
        return jsonRes(404, {})
      }
      return jsonRes(500, { unexpected: url })
    })
    const res = await syncEntitlement(BASE_ENV, 'a@x.com', 'free')
    expect(res.circle).toBe('ok')
  })

  test('skips Circle when token absent', async () => {
    installFetch(() => jsonRes(500, {}))
    const res = await syncEntitlement({ ...BASE_ENV, CIRCLE_API_TOKEN: '' }, 'a@x.com', 'circle')
    expect(res.circle).toBe('skipped')
    expect(calls.length).toBe(0)
  })

  test('skips Circle when access group id absent', async () => {
    installFetch(() => jsonRes(500, {}))
    const res = await syncEntitlement(
      { ...BASE_ENV, CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: '' },
      'a@x.com',
      'circle',
    )
    expect(res.circle).toBe('skipped')
  })
})

// --- emailForStripeCustomer -------------------------------------------------

// The server gates on deriveEntitlements(tier).circle so a future tier that
// carries community is covered the moment it exists. The client has no
// entitlement module and mirrors that in a hardcoded list, which is only safe
// while the two agree — so make the day they stop agreeing a red test rather
// than a purchase that skips the gate.
describe('requiresAgeGate mirrors the circle entitlement', () => {
  const ALL_TIERS: Tier[] = ['ark-plus', 'circle', 'bundle', 'free']
  for (const tier of ALL_TIERS) {
    test(`${tier}`, () => {
      expect(requiresAgeGate(tier)).toBe(deriveEntitlements(tier).circle)
    })
  }
})

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
    expect(await emailForStripeCustomer('cus_2', stripe)).toBe('b@x.com')
    expect(retrievedWith).toBe('cus_2')
  })

  test('returns null for null input', async () => {
    expect(await emailForStripeCustomer(null, {} as Stripe)).toBeNull()
  })
})

// --- reconcileEntitlements (Neon-authoritative drift removal) ----------------

// A Neon membership row (only the reconcile-projected columns matter).
function row(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    auth0_sub: 'auth0|x',
    sc_user_id: null,
    tier: 'free',
    status: 'active',
    stripe_subscription_id: null,
    ark_plus_gift_expires_at: null,
    circle_gift_expires_at: null,
    ...over,
  }
}

// Fetch handler for the reconciler: SC roster (/memberships), SC user delete
// (/users/{id}), Circle access-group list + members roster + DELETE, and Beehiiv
// (tolerated during drift downgrade).
function reconcilerFetch(opts: {
  scMembers?: Array<{ user_id: number; email: string }>
  // Circle group members → { auth0_sub (custom field), email }.
  circleMembers?: Array<{ auth0Sub: string | null; email: string }>
}): FetchHandler {
  const scMembers = opts.scMembers ?? []
  const circleMembers = opts.circleMembers ?? []
  const idFor = new Map(circleMembers.map((m, i) => [m, i + 1] as const))
  return ({ url, init }) => {
    // Beehiiv — tolerated no-op during a drift downgrade.
    if (url.includes('api.beehiiv.com')) return jsonRes(404, {})
    // SC memberships roster.
    if (url.includes('/memberships')) {
      return jsonRes(200, { data: scMembers, current_page: 1, last_page: 1 })
    }
    // SC user delete.
    if (url.includes('/users/') && init?.method === 'DELETE') {
      return jsonRes(200, {})
    }
    // SC user search (beehiiv known-reader etc.) — empty.
    if (url.includes('/users/search')) return jsonRes(200, { users: [] })
    // Circle access-group list.
    if (url.includes('/access_groups/ag-99/community_members')) {
      if (init?.method === 'DELETE') return jsonRes(200, {})
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '1')
      const records =
        page === 1
          ? circleMembers.map((m) => ({ community_member_id: idFor.get(m)! }))
          : []
      return jsonRes(200, { records, has_next_page: false })
    }
    // Circle full members roster (id → email + profile_fields.auth0_sub).
    if (url.includes('/community_members')) {
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '1')
      const records =
        page === 1
          ? circleMembers.map((m) => ({
              id: idFor.get(m)!,
              email: m.email,
              profile_fields: { auth0_sub: m.auth0Sub },
            }))
          : []
      return jsonRes(200, { records, has_next_page: false })
    }
    return jsonRes(500, { unexpected: url })
  }
}

describe('reconcileEntitlements', () => {
  test('no DATABASE_URL → skips (Neon is the authority)', async () => {
    installFetch(() => jsonRes(500, {}))
    const summary = await reconcileEntitlements(
      { ...BASE_ENV, DATABASE_URL: '' },
      {} as Stripe,
    )
    expect(summary).toEqual({ scanned: 0, scRemoved: 0, circleRemoved: 0, errors: 0 })
    expect(calls.length).toBe(0)
  })

  test('SC drift: deletes an SC user not in Neon arkPlus keep-set', async () => {
    // Neon: one live arkPlus member on sc_user_id 1.
    neonMembershipRows = [row({ auth0_sub: 'auth0|keep', tier: 'ark-plus', sc_user_id: 1 })]
    installFetch(
      reconcilerFetch({
        scMembers: [
          { user_id: 1, email: 'keep@x.com' }, // in keep-set → left alone
          { user_id: 2, email: 'drift@x.com' }, // not in Neon → removed
        ],
      }),
    )
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.scRemoved).toBe(1)
    expect(summary.errors).toBe(0)
    const del = calls.find((c) => c.url.includes('/users/2') && c.init?.method === 'DELETE')
    expect(del).toBeDefined()
    // The kept member is never deleted.
    expect(calls.some((c) => c.url.includes('/users/1') && c.init?.method === 'DELETE')).toBe(false)
  })

  test('SC drift: an expired gift row is not in the keep-set → its SC user is removed', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    neonMembershipRows = [
      // A live member keeps the keep-set non-empty so the empty-keep-set fail-
      // safe doesn't trip; the expired gift member is the drift under test.
      row({ auth0_sub: 'auth0|live', tier: 'ark-plus', sc_user_id: 1 }),
      row({ auth0_sub: 'auth0|gift', tier: 'ark-plus', sc_user_id: 5, ark_plus_gift_expires_at: past }),
    ]
    installFetch(
      reconcilerFetch({
        scMembers: [
          { user_id: 1, email: 'live@x.com' },
          { user_id: 5, email: 'gift@x.com' },
        ],
      }),
    )
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.scRemoved).toBe(1)
    expect(
      calls.some((c) => c.url.includes('/users/5') && c.init?.method === 'DELETE'),
    ).toBe(true)
  })

  test('SC roster loads on the v1 API; deletes go to v2', async () => {
    // The membership roster lives on the key-scoped v1 API; DELETE /users is v2.
    // Loading the roster with the v2 client would 404 and silently disable all
    // drift removal, so assert each call hits its correct base.
    neonMembershipRows = [row({ auth0_sub: 'auth0|keep', tier: 'ark-plus', sc_user_id: 1 })]
    installFetch(
      reconcilerFetch({
        scMembers: [
          { user_id: 1, email: 'keep@x.com' },
          { user_id: 2, email: 'drift@x.com' },
        ],
      }),
    )
    await reconcileEntitlements(BASE_ENV, {} as Stripe)
    const roster = calls.find((c) => c.url.includes('/memberships'))
    expect(roster?.url).toContain('/v1/')
    const del = calls.find((c) => c.url.includes('/users/2') && c.init?.method === 'DELETE')
    expect(del?.url).toContain('/v2/')
  })

  test('SC drift: empty keep-set against a non-empty roster → skips removal (fail-safe)', async () => {
    // No live arkPlus rows (e.g. Neon not yet backfilled). Removing every SC
    // member as "drift" would wipe the paid roster, so the axis must no-op.
    neonMembershipRows = []
    installFetch(reconcilerFetch({ scMembers: [{ user_id: 7, email: 'live@x.com' }] }))
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.scRemoved).toBe(0)
    expect(
      calls.some((c) => c.url.includes('/users/7') && c.init?.method === 'DELETE'),
    ).toBe(false)
  })

  test('SC drift: a live arkPlus row with a null sc_user_id → skips removal (incomplete keep-set)', async () => {
    // The null-sc_user_id member can't be matched to the roster, so the keep-set
    // is known-incomplete; deleting the "unmatched" roster entry could revoke a
    // live feed. Skip removal this run rather than risk it.
    neonMembershipRows = [
      row({ auth0_sub: 'auth0|noscid', tier: 'ark-plus', sc_user_id: null }),
      row({ auth0_sub: 'auth0|ok', tier: 'ark-plus', sc_user_id: 1 }),
    ]
    installFetch(reconcilerFetch({ scMembers: [{ user_id: 2, email: 'drift@x.com' }] }))
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.scRemoved).toBe(0)
  })

  test('SC drift: a future gift row keeps its SC user', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    neonMembershipRows = [
      row({ auth0_sub: 'auth0|gift', tier: 'ark-plus', sc_user_id: 5, ark_plus_gift_expires_at: future }),
    ]
    installFetch(reconcilerFetch({ scMembers: [{ user_id: 5, email: 'gift@x.com' }] }))
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.scRemoved).toBe(0)
  })

  test('Circle drift: removes a group member whose auth0_sub is not in the Neon circle keep-set', async () => {
    neonMembershipRows = [row({ auth0_sub: 'auth0|keep', tier: 'circle' })]
    installFetch(
      reconcilerFetch({
        circleMembers: [
          { auth0Sub: 'auth0|keep', email: 'keep@x.com' }, // in keep-set
          { auth0Sub: 'auth0|drift', email: 'drift@x.com' }, // stale → removed
        ],
      }),
    )
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.circleRemoved).toBe(1)
    const del = calls.find(
      (c) =>
        c.url.includes('/access_groups/ag-99/community_members') &&
        c.url.includes('email=drift%40x.com') &&
        c.init?.method === 'DELETE',
    )
    expect(del).toBeDefined()
  })

  test('Circle drift: a member with an unstamped auth0_sub is left alone', async () => {
    // A live circle member keeps the keep-set non-empty (so the empty-keep-set
    // fail-safe doesn't trip); the unstamped member can't be positively
    // identified as stale, so it is left alone.
    neonMembershipRows = [row({ auth0_sub: 'auth0|keep', tier: 'circle' })]
    installFetch(
      reconcilerFetch({
        circleMembers: [
          { auth0Sub: 'auth0|keep', email: 'keep@x.com' },
          { auth0Sub: null, email: 'unstamped@x.com' },
        ],
      }),
    )
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.circleRemoved).toBe(0)
  })

  test('Circle drift: empty keep-set against a non-empty group → skips removal (fail-safe)', async () => {
    neonMembershipRows = []
    installFetch(
      reconcilerFetch({ circleMembers: [{ auth0Sub: 'auth0|x', email: 'x@x.com' }] }),
    )
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.circleRemoved).toBe(0)
  })

  test('bundle grants both axes: its SC user and Circle membership are both kept', async () => {
    neonMembershipRows = [row({ auth0_sub: 'auth0|b', tier: 'bundle', sc_user_id: 9 })]
    installFetch(
      reconcilerFetch({
        scMembers: [{ user_id: 9, email: 'b@x.com' }],
        circleMembers: [{ auth0Sub: 'auth0|b', email: 'b@x.com' }],
      }),
    )
    const summary = await reconcileEntitlements(BASE_ENV, {} as Stripe)
    expect(summary.scRemoved).toBe(0)
    expect(summary.circleRemoved).toBe(0)
  })

  test('SC axis is skipped when SC_API_KEY is unset', async () => {
    neonMembershipRows = [row({ auth0_sub: 'auth0|k', tier: 'ark-plus', sc_user_id: 1 })]
    installFetch(reconcilerFetch({ scMembers: [{ user_id: 2, email: 'drift@x.com' }] }))
    const summary = await reconcileEntitlements({ ...BASE_ENV, SC_API_KEY: '' }, {} as Stripe)
    expect(summary.scRemoved).toBe(0)
    expect(calls.some((c) => c.url.includes('/memberships'))).toBe(false)
  })
})
