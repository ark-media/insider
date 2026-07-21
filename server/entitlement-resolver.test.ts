// Win-back guardrail (T-010): a cancelled or absent membership must resolve to
// `free` — no access leak. After a full cancel the membership row is torn down
// (subscription.deleted) while the cancellation record + Beehiiv consent persist
// by email; the resolver must never grant a paid tier from a stale/absent row.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

// Neon mock: the `from membership` select returns whatever the test stages.
let membershipRows: unknown[] = []
mock.module('@neondatabase/serverless', () => ({
  neon:
    (_url: string) =>
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const merged = strings.join('?')
      if (merged.includes('from membership')) return Promise.resolve(membershipRows)
      return Promise.resolve([])
    },
  __esModule: true,
}))

// Import AFTER mock.module so getDb picks up the fake neon driver.
import { resolveMembershipForIdentity } from './lib/entitlement-resolver'
import type { RequestIdentity } from './lib/session'

// The SC-by-email net (2b) issues a real fetch via createScClient. Stub fetch at
// the global level (not the module — mock.module leaks across the shared test
// process) so tests that fall through to it stay off the network and find no SC
// user → the fall-through resolves to `free`. Restored after this file's tests.
const realFetch = globalThis.fetch
globalThis.fetch = (() =>
  Promise.resolve(new Response(JSON.stringify({ users: [] }), { status: 200 }))) as typeof fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

// A minimal Stripe stand-in: customers.list returns one customer whose id the
// by-customer membership lookup then resolves against the staged rows.
const fakeStripe = {
  customers: { list: () => Promise.resolve({ data: [{ id: 'cus_1' }] }) },
} as never
// Stripe that knows no customer for this email (drops to the SC net).
const emptyStripe = {
  customers: { list: () => Promise.resolve({ data: [] }) },
} as never

// A sub-less session (checkout token minted before Auth0 provisioning stamped a
// sub) — the case the true-tier by-email fallback exists for.
const SUBLESS: RequestIdentity = { sub: null, email: 'buyer@example.com' } as RequestIdentity

const ENV = {
  DATABASE_URL: 'postgres://stub-resolver-test',
  // Present so createScClient builds for the SC-net fall-through; the stubbed
  // fetch above makes the search return no user regardless.
  SC_NETWORK_ID: 'test-net',
  SC_API_KEY: 'test-sc-key',
} as Record<string, string>
const IDENTITY: RequestIdentity = { sub: 'auth0|123', email: 'gone@example.com' } as RequestIdentity

// A membership row shaped like getMembershipByAuth0Sub's projection.
const row = (over: Record<string, unknown>) => ({
  auth0_sub: 'auth0|123',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  sc_user_id: 42,
  tier: 'ark-plus',
  status: 'active',
  plan: 'monthly',
  amount_cents: 800,
  current_period_end: null,
  cancel_at: null,
  gift_expires_at: null,
  ...over,
})

beforeEach(() => {
  membershipRows = []
})

describe('resolveMembershipForIdentity — no access leak', () => {
  test('absent membership row (post-teardown) resolves to free', async () => {
    membershipRows = [] // row deleted after subscription.deleted
    const res = await resolveMembershipForIdentity(IDENTITY, ENV)
    expect(res.tier).toBe('free')
    expect(res.entitlements).toEqual({ arkPlus: false, circle: false })
    expect(res.origin).toBe('none')
    expect(res.scUserId).toBeNull()
  })

  test('a downgraded-to-free row grants nothing', async () => {
    membershipRows = [row({ tier: 'free' })]
    const res = await resolveMembershipForIdentity(IDENTITY, ENV)
    expect(res.tier).toBe('free')
    expect(res.entitlements).toEqual({ arkPlus: false, circle: false })
  })

  test('an expired gift membership is not live → free (no leak)', async () => {
    membershipRows = [row({ tier: 'ark-plus', gift_expires_at: '2000-01-01T00:00:00.000Z' })]
    const res = await resolveMembershipForIdentity(IDENTITY, ENV)
    expect(res.tier).toBe('free')
    expect(res.entitlements).toEqual({ arkPlus: false, circle: false })
  })

  test('sanity: a live paid row still resolves (proves the free result is not a false-lock)', async () => {
    membershipRows = [row({ tier: 'bundle' })]
    const res = await resolveMembershipForIdentity(IDENTITY, ENV)
    expect(res.tier).toBe('bundle')
    expect(res.entitlements).toEqual({ arkPlus: true, circle: true })
    expect(res.origin).toBe('neon')
  })
})

// The reported bug: a bundle member on a sub-less checkout session was resolved
// as ark-plus, because the resolver only looked up membership by sub and the
// email net hardcoded arkPlus. The by-email → Stripe customer → Neon row lookup
// restores the true tier without leaking access.
describe('resolveMembershipForIdentity — true-tier by-email fallback', () => {
  test('sub-less session resolves the real tier (bundle) via Stripe customer, not ark-plus', async () => {
    membershipRows = [row({ tier: 'bundle' })]
    const res = await resolveMembershipForIdentity(SUBLESS, ENV, {
      scFallback: true,
      stripe: fakeStripe,
    })
    expect(res.tier).toBe('bundle')
    expect(res.entitlements).toEqual({ arkPlus: true, circle: true })
    expect(res.origin).toBe('neon')
    expect(res.scUserId).toBe(42)
  })

  test('a circle member is likewise not flattened to ark-plus', async () => {
    membershipRows = [row({ tier: 'circle' })]
    const res = await resolveMembershipForIdentity(SUBLESS, ENV, {
      scFallback: true,
      stripe: fakeStripe,
    })
    expect(res.tier).toBe('circle')
    expect(res.entitlements).toEqual({ arkPlus: false, circle: true })
  })

  test('no leak: a not-live row found by customer is ignored (not resolved to its paid tier)', async () => {
    // Row is present by customer but cancelled/expired → must not grant its tier.
    // The SC net finds no user here (stubbed fetch), so it falls through to free.
    membershipRows = [row({ tier: 'bundle', gift_expires_at: '2000-01-01T00:00:00.000Z' })]
    const res = await resolveMembershipForIdentity(SUBLESS, ENV, {
      scFallback: true,
      stripe: fakeStripe,
    })
    expect(res.tier).toBe('free')
    expect(res.entitlements).toEqual({ arkPlus: false, circle: false })
  })

  test('no Stripe customer for the email → does not resolve the row, drops to the net', async () => {
    membershipRows = [row({ tier: 'bundle' })] // present, but no customer resolves it
    const res = await resolveMembershipForIdentity(SUBLESS, ENV, {
      scFallback: true,
      stripe: emptyStripe,
    })
    expect(res.tier).toBe('free')
  })

  test('true-tier lookup is opt-in: no stripe passed → the by-customer step is skipped', async () => {
    membershipRows = [row({ tier: 'bundle' })]
    const res = await resolveMembershipForIdentity(SUBLESS, ENV, { scFallback: true })
    expect(res.tier).toBe('free')
  })
})
