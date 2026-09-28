// Membership Change Matrix — gift claim + term length.
//
//   N1  A successful POST /api/gift/claim provisions the recipient through
//       findOrCreateAuth0User (created pre-verified) and logs them in with the
//       ark_session cookie.
//   N2  The recipient's gift end date = start + GIFT_TERM_DAYS[term], where the
//       start stacks from a still-future expiry on the same axis.
//
// Harness: Stripe stubbed (the claim never touches it for a fresh recipient),
// Neon via neonMockModule, and the Auth0 SDK faked so the real
// findOrCreateAuth0User runs against it. Beehiiv/Circle are unconfigured, so the
// activator's grants no-op and only the Neon row carries the term.

import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import {
  createDevApiHarness,
  neonMockModule,
  silenceExpectedConsole,
  type SqlCall,
} from './test-utils'

mock.module('stripe', () => ({ default: class {}, __esModule: true }))

// --- Neon -------------------------------------------------------------------
const sqlCalls: SqlCall[] = []
let giftRow: Record<string, unknown> | null = null
let membershipRow: Record<string, unknown> | null = null
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql) => {
    if (sql.includes('from gift where redemption_token')) return giftRow ? [giftRow] : []
    if (sql.includes('from membership where auth0_sub')) return membershipRow ? [membershipRow] : []
    if (sql.includes("update gift set status = 'redeemed'")) {
      return [{ redemption_token: giftRow?.redemption_token }]
    }
    return []
  }),
)

// --- Auth0 SDK --------------------------------------------------------------
type Auth0User = {
  user_id: string
  created_at?: string
  identities: Array<{ connection: string; user_id?: string }>
}
let auth0Users: Auth0User[] = []
const auth0Creates: Array<Record<string, unknown>> = []
mock.module('auth0', () => ({
  ManagementClient: class {
    users = {
      listUsersByEmail: async () => auth0Users,
      create: async (args: Record<string, unknown>) => {
        auth0Creates.push(args)
        if (args.connection === 'email') {
          return { user_id: 'email|e1', identities: [{ connection: 'email', user_id: 'e1' }] }
        }
        return {
          user_id: 'auth0|recipient',
          identities: [{ connection: 'Username-Password-Authentication' }],
        }
      },
      update: async () => ({}),
      identities: { link: async () => [] },
    }
  },
  AuthenticationClient: class {},
  __esModule: true,
}))

import { devApiPlugin } from './dev-api'
import { signGiftClaimToken, verifySessionToken } from './lib/session'
import { createActivator, GIFT_TERM_DAYS } from './lib/activation'
import { planGiftRedemption } from './routes/gift'

const ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-gift-matrix-claim',
  AUTH0_MANAGEMENT_CLIENT_ID: 'mgmt-id-gift-matrix-claim',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'mgmt-secret',
}
const harness = createDevApiHarness(devApiPlugin(ENV))

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-27T12:00:00.000Z')

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch

silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  setSystemTime(new Date(NOW))
  sqlCalls.length = 0
  auth0Creates.length = 0
  auth0Users = []
  membershipRow = null
  giftRow = {
    redemption_token: 'gt_claim_1',
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
    { giftToken: 'gt_claim_1', email: 'rae@example.com', name: 'Rae Recipient', tier: 'ark-plus' },
    ENV,
  )
  return harness.call('/api/gift/claim', { method: 'POST', body: { mt } })
}

// The membership upsert the redemption wrote (values 10/11 = the per-axis gift
// expiries, in upsertMembership's column order).
function membershipUpsert(): SqlCall {
  const call = sqlCalls.find((c) => c.sql.includes('insert into membership'))
  if (!call) throw new Error('no membership upsert')
  return call
}

function sessionCookieFrom(setCookie: string | undefined): string | null {
  return /ark_session=([^;,\s]+)/.exec(setCookie ?? '')?.[1] ?? null
}

describe('N1 — POST /api/gift/claim success', () => {
  test('new recipient: findOrCreateAuth0User creates a pre-verified Database account', async () => {
    const res = await claim()
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toMatchObject({ redeemed: true, applied: 'membership' })

    const dbCreate = auth0Creates.find((a) => a.connection === 'Username-Password-Authentication')
    expect(dbCreate).toBeDefined()
    expect(dbCreate!.email).toBe('rae@example.com')
    expect(dbCreate!.email_verified).toBe(true)
    expect(dbCreate!.verify_email).toBe(false)
    // Name split from the single name the giver typed.
    expect(dbCreate!.given_name).toBe('Rae')
    expect(dbCreate!.family_name).toBe('Recipient')
    // The passwordless code identity is provisioned verified too.
    const codeCreate = auth0Creates.find((a) => a.connection === 'email')
    expect(codeCreate).toMatchObject({ email_verified: true, verify_email: false })
  })

  test('sets an HttpOnly ark_session cookie for the recipient (email_link session)', async () => {
    const res = await claim()
    expect(res.statusCode).toBe(200)
    const setCookie = res.__headers()['set-cookie']
    expect(setCookie).toContain('ark_session=')
    expect(setCookie).toContain('HttpOnly')

    const token = sessionCookieFrom(setCookie)
    expect(token).not.toBeNull()
    const session = await verifySessionToken(token!, ENV)
    expect(session).toMatchObject({
      email: 'rae@example.com',
      sub: 'auth0|recipient',
      roles: [],
      via: 'email_link',
      givenName: 'Rae',
      familyName: 'Recipient',
    })
  })

  test('existing account: found, not recreated — still logged in under its sub', async () => {
    auth0Users = [
      {
        user_id: 'auth0|existing',
        identities: [{ connection: 'Username-Password-Authentication' }, { connection: 'email' }],
      },
    ]
    const res = await claim()
    expect(res.statusCode).toBe(200)
    expect(auth0Creates).toHaveLength(0)
    const session = await verifySessionToken(sessionCookieFrom(res.__headers()['set-cookie'])!, ENV)
    expect(session?.sub).toBe('auth0|existing')
    // The row keys on the resolved sub.
    expect(membershipUpsert().values[0]).toBe('auth0|existing')
  })

  test('gift already redeemed → 409 and NO session cookie, no Auth0 provisioning', async () => {
    giftRow = { ...giftRow, status: 'redeemed' }
    const res = await claim()
    expect(res.statusCode).toBe(409)
    expect(res.__headers()['set-cookie']).toBeUndefined()
    expect(auth0Creates).toHaveLength(0)
  })
})

describe('N2 — gift end date = start + GIFT_TERM_DAYS', () => {
  test('term lengths: 6mo = 182 days, 1yr = 365 days', () => {
    expect(GIFT_TERM_DAYS).toEqual({ '6mo': 182, '1yr': 365 })
  })

  test('fresh 1yr claim writes ark_plus_gift_expires_at = now + 365d', async () => {
    const res = await claim()
    expect(res.statusCode).toBe(200)
    const expected = new Date(NOW + 365 * DAY_MS).toISOString()
    expect(membershipUpsert().values[10]).toBe(expected)
    expect(membershipUpsert().values[11]).toBeNull()
    expect((res.__json() as { expires_at: string }).expires_at).toBe(expected)
  })

  test('fresh 6mo claim writes now + 182d', async () => {
    giftRow = { ...giftRow, plan: '6mo', amount_cents: 4800 }
    const res = await claim()
    expect(res.statusCode).toBe(200)
    expect(membershipUpsert().values[10]).toBe(new Date(NOW + 182 * DAY_MS).toISOString())
  })

  test('stacks from a still-future gift expiry on the same axis', async () => {
    const existingExpiry = new Date(NOW + 40 * DAY_MS).toISOString()
    membershipRow = {
      auth0_sub: 'auth0|recipient',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier: 'ark-plus',
      status: 'active',
      plan: '6mo',
      amount_cents: 4800,
      currency: 'usd',
      current_period_end: null,
      cancel_at: null,
      ark_plus_gift_expires_at: existingExpiry,
      circle_gift_expires_at: null,
    }
    const res = await claim()
    expect(res.statusCode).toBe(200)
    expect(membershipUpsert().values[10]).toBe(
      new Date(NOW + 40 * DAY_MS + 365 * DAY_MS).toISOString(),
    )
  })

  test('a lapsed expiry does not stack — the term starts now', async () => {
    membershipRow = {
      auth0_sub: 'auth0|recipient',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier: 'ark-plus',
      status: 'active',
      plan: '1yr',
      amount_cents: 8000,
      currency: 'usd',
      current_period_end: null,
      cancel_at: null,
      ark_plus_gift_expires_at: new Date(NOW - 5 * DAY_MS).toISOString(),
      circle_gift_expires_at: null,
    }
    await claim()
    expect(membershipUpsert().values[10]).toBe(new Date(NOW + 365 * DAY_MS).toISOString())
  })

  test('activator: per-axis end = from + term, each axis from its own start', async () => {
    const activator = createActivator({}, null)
    const arkFrom = NOW + 10 * DAY_MS // stacked on a live Ark+ gift
    const out = await activator.activateGiftForRecipient({
      email: 'rae@example.com',
      auth0Sub: 'auth0|recipient',
      term: '6mo',
      giftToken: 'gt_x',
      arkPlusFromMs: arkFrom,
      circleFromMs: NOW,
    })
    expect(out.arkPlusEndsAt).toBe(new Date(arkFrom + 182 * DAY_MS).toISOString())
    expect(out.circleEndsAt).toBe(new Date(NOW + 182 * DAY_MS).toISOString())
  })

  test('planner + activator: bundle gift on a row with a future Fold gift stacks only the Fold axis', async () => {
    const circleExpiry = NOW + 30 * DAY_MS
    const plan = planGiftRedemption(
      { tier: 'bundle' },
      {
        tier: 'circle',
        status: 'active',
        stripe_subscription_id: null,
        stripe_customer_id: null,
        ark_plus_gift_expires_at: null,
        circle_gift_expires_at: new Date(circleExpiry).toISOString(),
      },
      NOW,
    )
    const out = await createActivator({}, null).activateGiftForRecipient({
      email: 'rae@example.com',
      auth0Sub: 'auth0|recipient',
      term: '1yr',
      giftToken: 'gt_x',
      arkPlusFromMs: plan.arkPlusFromMs,
      circleFromMs: plan.circleFromMs,
    })
    expect(out.arkPlusEndsAt).toBe(new Date(NOW + 365 * DAY_MS).toISOString())
    expect(out.circleEndsAt).toBe(new Date(circleExpiry + 365 * DAY_MS).toISOString())
  })
})
