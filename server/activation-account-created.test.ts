// `accountCreated` is what /api/auth/checkout-session hands its post-payment
// session out on, so it has to be right in the one way that matters: true for an
// account THIS purchase created, false for one that was already there.
//
// The buyer's email is typed and never proven. Signing a buyer in to an account
// that already existed — a comped member, a gift recipient, staff — was an
// impersonation for the price of the cheapest plan. And the answer has to
// survive the webhook getting there first: by the time the browser polls, the
// account "already exists" because the webhook just made it. Hence the marker on
// the subscription, which is what these tests pin.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import type Stripe from 'stripe'

// Accounts Auth0 already holds, by email. Empty = nobody has this address.
let existingUsers: Array<{ user_id: string; identities: Array<{ connection: string }> }> = []
const created: string[] = []

mock.module('auth0', () => ({
  ManagementClient: class {
    users = {
      listUsersByEmail: async () => existingUsers,
      create: async ({ email, connection }: { email: string; connection: string }) => {
        created.push(`${connection}:${email}`)
        return { user_id: `auth0|new-${created.length}` }
      },
      update: async () => ({}),
      identities: { link: async () => [] },
    }
  },
  AuthenticationClient: class {},
  __esModule: true,
}))

const { createActivator } = await import('./lib/activation')
const { silenceExpectedConsole } = await import('./test-utils')

silenceExpectedConsole()

const ENV = {
  APP_BASE_URL: 'http://localhost:5173',
  // Unique to this file: getManagementClient caches its client by domain + id,
  // so sharing another suite's id would hand these tests that suite's fake.
  AUTH0_MANAGEMENT_CLIENT_ID: 'mgmt-account-created-test',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'mgmt-secret',
}

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
afterAll(() => {
  globalThis.fetch = originalFetch
})

// A Circle-only subscription keeps Beehiiv out of the picture; Circle itself is
// unconfigured here and soft-skips. What's left is the Auth0 step under test.
function fakeStripe(metadata: Record<string, string>) {
  const sub = {
    id: 'sub_1',
    customer: 'cus_1',
    metadata: { plan: 'monthly', ...metadata },
  }
  const updates: Array<Record<string, string>> = []
  const stripe = {
    subscriptions: {
      retrieve: async () => sub,
      update: async (_id: string, args: { metadata: Record<string, string> }) => {
        updates.push(args.metadata)
        sub.metadata = { ...sub.metadata, ...args.metadata }
        return sub
      },
    },
    customers: {
      retrieve: async () => ({ id: 'cus_1', email: 'buyer@example.com', name: 'Test Buyer' }),
    },
  } as unknown as Stripe
  return { stripe, sub: sub as unknown as Stripe.Subscription, updates }
}

beforeEach(() => {
  existingUsers = []
  created.length = 0
})

describe('activateMembershipForStripeSub — accountCreated', () => {
  test('true, and stamped on the subscription, when this purchase created the account', async () => {
    const { stripe, sub, updates } = fakeStripe({})
    const result = await createActivator(ENV, stripe).activateMembershipForStripeSub(sub, 'circle')

    expect(created.length).toBeGreaterThan(0)
    expect(result.accountCreated).toBe(true)
    expect(updates.at(-1)?.auth0_account_created).toBe('true')
  })

  test('false, and NOT stamped, when the address already had an account', async () => {
    existingUsers = [
      {
        user_id: 'auth0|victim',
        identities: [{ connection: 'Username-Password-Authentication' }],
      },
    ]
    const { stripe, sub, updates } = fakeStripe({})
    const result = await createActivator(ENV, stripe).activateMembershipForStripeSub(sub, 'circle')

    expect(result.auth0Sub).toBe('auth0|victim')
    expect(result.accountCreated).toBe(false)
    expect(updates.at(-1)?.auth0_account_created).toBeUndefined()
  })

  test('still true on a later call, after the webhook created the account first', async () => {
    // The webhook ran, created the login and stamped both markers. The browser's
    // poll arrives next, on another instance: no create happens this time.
    const { stripe, sub } = fakeStripe({
      auth0_user_id: 'auth0|new-1',
      auth0_account_created: 'true',
    })
    const result = await createActivator(ENV, stripe).activateMembershipForStripeSub(sub, 'circle')

    expect(created).toHaveLength(0)
    expect(result.accountCreated).toBe(true)
  })

  test('a provisioned sub with no marker reads as an existing account, via the fast path too', async () => {
    const { stripe, sub } = fakeStripe({
      auth0_user_id: 'auth0|victim',
      circle_provisioned: 'true',
    })
    const result = await createActivator(ENV, stripe).activateMembershipForStripeSub(sub, 'circle')
    expect(result.accountCreated).toBe(false)
  })
})
