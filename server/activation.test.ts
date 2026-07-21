// Tier-aware activation (task 4). Exercises createActivator's
// activateMembershipForStripeSub directly with a hand-rolled fake Stripe and a
// global fetch mock for the SC + Circle HTTP calls. Auth0 is left unconfigured
// (no AUTH0_MANAGEMENT_* env) so the management client is unavailable and the
// login soft-fails to a null sub — orthogonal to what these assert.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type Stripe from 'stripe'
import { createActivator } from './lib/activation'
import { silenceExpectedConsole } from './test-utils'

const ENV = {
  SC_NETWORK_ID: 'net_1',
  SC_API_KEY: 'sc_key',
  SC_SUBSCRIPTION_PRICE_ID_MONTHLY: '11',
  SC_SUBSCRIPTION_PRICE_ID_YEARLY: '22',
  CIRCLE_API_TOKEN: 'circle_tok',
  CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID: '122218',
  APP_BASE_URL: 'https://app.test',
}

// --- Fake Stripe ------------------------------------------------------------
// A single mutable metadata bag; subscriptions.update merges into it so the
// activator's re-reads see the just-stamped markers.
function makeFakeStripe(initialMeta: Record<string, string> = {}) {
  const meta: Record<string, string> = { plan: 'yearly', ...initialMeta }
  const sub = {
    id: 'sub_1',
    customer: 'cus_1',
    get metadata() {
      return { ...meta }
    },
  }
  const stripe = {
    subscriptions: {
      retrieve: async (_id: string) => ({ ...sub, metadata: { ...meta } }),
      update: async (_id: string, args: { metadata: Record<string, string> }) => {
        Object.assign(meta, args.metadata)
        return { ...sub, metadata: { ...meta } }
      },
    },
    customers: {
      retrieve: async (id: string) => ({ id, email: 'buyer@example.com', name: 'Buyer One' }),
    },
  }
  return { stripe: stripe as unknown as Stripe, sub: sub as unknown as Stripe.Subscription, meta }
}

// --- fetch mock -------------------------------------------------------------
let fetchUrls: Array<{ method: string; url: string }> = []
const realFetch = globalThis.fetch

function installFetch() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    fetchUrls.push({ method, url })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })

    // Supporting Cast
    if (url.endsWith('/users/search')) return json({ users: [] })
    if (url.endsWith('/users')) return json({ user: { id: 999, email: 'buyer@example.com' } })
    if (url.endsWith('/subscriptions')) return json({ subscription: { id: 555 } })
    // Circle: member create, profile-field stamp, access-group add
    if (url.endsWith('/community_members') && !url.includes('access_groups'))
      return json({ id: 42 }, 201)
    if (url.includes('/community_members/') && method === 'PUT') return json({ ok: true })
    if (url.includes('access_groups') && url.includes('community_members'))
      return json({ ok: true })
    return json({ ok: true })
  }) as typeof fetch
}

silenceExpectedConsole()

beforeEach(() => {
  fetchUrls = []
  installFetch()
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const scSubPost = () =>
  fetchUrls.some((c) => c.method === 'POST' && c.url.endsWith('/subscriptions'))
const circleGroupPost = () =>
  fetchUrls.some(
    (c) =>
      c.method === 'POST' && c.url.includes('access_groups') && c.url.includes('community_members'),
  )
const circleMemberCreate = () =>
  fetchUrls.some(
    (c) =>
      c.method === 'POST' &&
      c.url.endsWith('/community_members') &&
      !c.url.includes('access_groups'),
  )

describe('activateMembershipForStripeSub — tier-aware fan-out', () => {
  test('circle-only: provisions Circle, never touches Supporting Cast', async () => {
    const { stripe, sub } = makeFakeStripe()
    const activator = createActivator(ENV, stripe)
    const result = await activator.activateMembershipForStripeSub(sub, 'circle')

    expect(scSubPost()).toBe(false)
    expect(circleMemberCreate()).toBe(true)
    expect(circleGroupPost()).toBe(true)
    expect(result.scSubscriptionId).toBeNull()
    expect(result.tier).toBe('circle')
  })

  test('ark-plus: provisions Supporting Cast, never touches Circle', async () => {
    const { stripe, sub } = makeFakeStripe()
    const activator = createActivator(ENV, stripe)
    const result = await activator.activateMembershipForStripeSub(sub, 'ark-plus')

    expect(scSubPost()).toBe(true)
    expect(circleGroupPost()).toBe(false)
    expect(circleMemberCreate()).toBe(false)
    expect(result.scUserId).toBe(999)
    expect(result.scSubscriptionId).toBe(555)
  })

  test('bundle: provisions both axes', async () => {
    const { stripe, sub } = makeFakeStripe()
    const activator = createActivator(ENV, stripe)
    const result = await activator.activateMembershipForStripeSub(sub, 'bundle')

    expect(scSubPost()).toBe(true)
    expect(circleGroupPost()).toBe(true)
    expect(result.scSubscriptionId).toBe(555)
  })

  test('idempotent: a sub already marked provisioned makes no SC/Circle calls', async () => {
    const { stripe, sub } = makeFakeStripe({
      sc_subscription_id: '555',
      sc_user_id: '999',
      auth0_user_id: 'auth0|abc',
    })
    const activator = createActivator(ENV, stripe)
    const result = await activator.activateMembershipForStripeSub(sub, 'ark-plus')

    expect(fetchUrls.length).toBe(0)
    expect(result.scSubscriptionId).toBe(555)
    expect(result.auth0Sub).toBe('auth0|abc')
  })
})
