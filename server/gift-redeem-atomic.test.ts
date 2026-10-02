// Gift redemption's membership write (security review 2026-10):
//
//   - Stacking is atomic. Two redemptions for the same recipient both read the
//     same row; computing `now + term` from that read let the second write
//     erase the first gift's term. The upsert now stacks in SQL from the row
//     being updated, and the recipient is told the expiry the row really holds.
//   - A dead subscription is not revived. A recipient whose row still names a
//     canceled/paused/incomplete subscription gets that id (and its period)
//     cleared, not carried beside status 'active'.
//
// Harness follows gift-matrix-claim.test.ts: the claim route end to end, Neon
// via neonMockModule, Auth0 faked, Beehiiv/Circle unconfigured.

import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import {
  createDevApiHarness,
  neonMockModule,
  silenceExpectedConsole,
  type SqlCall,
} from './test-utils'

mock.module('stripe', () => ({ default: class {}, __esModule: true }))

const sqlCalls: SqlCall[] = []
let giftRow: Record<string, unknown> | null = null
let membershipRow: Record<string, unknown> | null = null
// What the membership upsert's `returning` hands back — the row as written.
let upsertReturns: Record<string, unknown>[] = []
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql) => {
    if (sql.includes('from gift where redemption_token')) return giftRow ? [giftRow] : []
    if (sql.includes('from membership where auth0_sub')) return membershipRow ? [membershipRow] : []
    if (sql.includes("update gift set status = 'redeemed'")) {
      return [{ redemption_token: giftRow?.redemption_token }]
    }
    if (sql.includes('insert into membership')) return upsertReturns
    return []
  }),
)

mock.module('auth0', () => ({
  ManagementClient: class {
    users = {
      listUsersByEmail: async () => [
        {
          user_id: 'auth0|recipient',
          identities: [{ connection: 'Username-Password-Authentication' }, { connection: 'email' }],
        },
      ],
      create: async () => ({}),
      update: async () => ({}),
      identities: { link: async () => [] },
    }
  },
  AuthenticationClient: class {},
  __esModule: true,
}))

import { devApiPlugin } from './dev-api'
import { signGiftClaimToken } from './lib/session'

const ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-gift-redeem-atomic',
  AUTH0_MANAGEMENT_CLIENT_ID: 'mgmt-id-gift-redeem-atomic',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'mgmt-secret',
}
const harness = createDevApiHarness(devApiPlugin(ENV))

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-02T12:00:00.000Z')

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch

silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  setSystemTime(new Date(NOW))
  sqlCalls.length = 0
  membershipRow = null
  upsertReturns = []
  giftRow = {
    redemption_token: 'gt_atomic_1',
    tier: 'ark-plus',
    plan: '1yr',
    amount_cents: 8000,
    currency: 'usd',
    giver_sub: null,
    status: 'pending',
    redeemed_by: null,
  }
})
afterEach(() => {
  setSystemTime()
})

async function claim(): Promise<Awaited<ReturnType<typeof harness.call>>> {
  const mt = await signGiftClaimToken(
    { giftToken: 'gt_atomic_1', email: 'rae@example.com', name: 'Rae Recipient', tier: 'ark-plus' },
    ENV,
  )
  return harness.call('/api/gift/claim', { method: 'POST', body: { mt } })
}

function membershipUpsert(): SqlCall {
  const call = sqlCalls.find((c) => c.sql.includes('insert into membership'))
  if (!call) throw new Error('no membership upsert')
  return call
}

describe('gift stacking is computed in SQL, from the row being written', () => {
  test('the conflict branch stacks greatest(current expiry, now()) + the term', async () => {
    const res = await claim()
    expect(res.statusCode).toBe(200)
    const { sql, values } = membershipUpsert()
    expect(sql).toContain(
      'greatest(coalesce(membership.ark_plus_gift_expires_at, now()), now())',
    )
    expect(sql).toContain('greatest(coalesce(membership.circle_gift_expires_at, now()), now())')
    expect(sql).toContain('make_interval(days => ')
    expect(sql).toContain('returning ark_plus_gift_expires_at, circle_gift_expires_at')
    // The 1yr term is bound as the stacking interval.
    expect(values.slice(12)).toContain(365)
  })

  test('the recipient is told the expiry the row holds, not the one planned from a stale read', async () => {
    // A concurrent redemption landed first: the row already held a year when
    // this write stacked onto it, so the DB returns two years from now.
    const stacked = new Date(NOW + 730 * DAY_MS)
    upsertReturns = [{ ark_plus_gift_expires_at: stacked, circle_gift_expires_at: null }]
    const res = await claim()
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { expires_at: string }).expires_at).toBe(stacked.toISOString())
  })
})

describe('a dead subscription on the recipient row is not revived', () => {
  const deadSubRow = (status: string) => ({
    auth0_sub: 'auth0|recipient',
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_dead',
    tier: 'ark-plus',
    status,
    plan: 'monthly',
    amount_cents: 800,
    currency: 'usd',
    current_period_end: new Date(NOW + 10 * DAY_MS).toISOString(),
    cancel_at: new Date(NOW + 10 * DAY_MS).toISOString(),
    ark_plus_gift_expires_at: null,
    circle_gift_expires_at: null,
  })

  for (const status of ['canceled', 'paused', 'incomplete', 'incomplete_expired']) {
    test(`${status}: sub id and period cleared, Customer kept, status active`, async () => {
      membershipRow = deadSubRow(status)
      const res = await claim()
      expect(res.statusCode).toBe(200)
      const v = membershipUpsert().values
      expect(v[1]).toBe('cus_1') // stripe_customer_id kept
      expect(v[2]).toBeNull() // stripe_subscription_id
      expect(v[4]).toBe('active') // status
      expect(v[8]).toBeNull() // current_period_end
      expect(v[9]).toBeNull() // cancel_at
    })
  }

  test('a live subscription keeps its own id and period', async () => {
    membershipRow = { ...deadSubRow('active'), tier: 'circle' }
    const res = await claim()
    expect(res.statusCode).toBe(200)
    const v = membershipUpsert().values
    expect(v[2]).toBe('sub_dead')
    expect(v[4]).toBe('active')
    expect(v[8]).toBe(membershipRow.current_period_end)
  })
})
