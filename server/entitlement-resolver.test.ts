// Win-back guardrail (T-010): a cancelled or absent membership must resolve to
// `free` — no access leak. After a full cancel the membership row is torn down
// (subscription.deleted) while the cancellation record + Beehiiv consent persist
// by email; the resolver must never grant a paid tier from a stale/absent row.

import { describe, test, expect, beforeEach, mock } from 'bun:test'

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

const ENV = { DATABASE_URL: 'postgres://stub-resolver-test' } as Record<string, string>
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
