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

// The same env with Resend configured, for the cases that assert on the email
// that goes out. ENV deliberately leaves it unset so every other case stays
// send-free.
const EMAIL_ENV = { ...ENV, RESEND_API_KEY: 'resend_key' }

// --- Fake Stripe ------------------------------------------------------------
// A single mutable metadata bag; subscriptions.update merges into it so the
// activator's re-reads see the just-stamped markers.
function makeFakeStripe(
  initialMeta: Record<string, string> = {},
  subOverrides: Record<string, unknown> = {},
) {
  const meta: Record<string, string> = { plan: 'yearly', ...initialMeta }
  const sub = {
    id: 'sub_1',
    customer: 'cus_1',
    // A realistic money shape: the axis-added email reads the item price and
    // the sub's currency to state what the member now pays.
    currency: 'usd',
    items: {
      data: [
        {
          id: 'si_1',
          price: {
            id: 'price_bundle_monthly',
            currency: 'usd',
            unit_amount: 2500,
            recurring: { interval: 'month' },
          },
          current_period_end: 1_789_000_000,
        },
      ],
    },
    ...subOverrides,
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
// Resend sends, captured by body so a test can assert WHICH email went out.
let sentEmails: Array<{ subject: string; html: string }> = []
const realFetch = globalThis.fetch

function installFetch() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    fetchUrls.push({ method, url })
    if (url.includes('api.resend.com')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { subject: string; html: string }
      sentEmails.push({ subject: body.subject, html: body.html })
      return new Response(JSON.stringify({ id: 'email_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
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
  sentEmails = []
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

  test('adding an axis emails the upgrade, not the welcome — with the new price', async () => {
    // An Ark+ member adding Community: they were provisioned long ago, so
    // `wasUnprovisioned` is false and the welcome email is (correctly) skipped.
    // Until this email existed that left the upgrade entirely silent — no
    // pointer to the community, and no notice of the new recurring price, which
    // Stripe's own receipt doesn't carry until the next invoice.
    const { stripe, sub } = makeFakeStripe({
      sc_subscription_id: '555',
      sc_user_id: '999',
      auth0_user_id: 'auth0|abc',
      amount_cents: '2500',
      currency: 'usd',
      plan: 'monthly',
    })
    const activator = createActivator(EMAIL_ENV, stripe)
    await activator.activateMembershipForStripeSub(sub, 'bundle')

    expect(circleGroupPost()).toBe(true)
    expect(sentEmails.length).toBe(1)
    expect(sentEmails[0].subject).toContain('community')
    expect(sentEmails[0].subject).not.toContain('Welcome')
    // The price is read off the metadata change-tier stamps, in the currency
    // the subscription actually bills in.
    expect(sentEmails[0].html).toContain('$25')
  })

  test('a non-USD sub is priced from the metadata, not the USD base', async () => {
    // A EUR subscription on a catalog price whose `unit_amount` is the USD
    // base: quoting that as euros would be wrong money, so the amount comes
    // from the `amount_cents`/`currency` pair change-tier stamps.
    const { stripe, sub } = makeFakeStripe(
      {
        sc_subscription_id: '555',
        sc_user_id: '999',
        auth0_user_id: 'auth0|abc',
        amount_cents: '2300',
        currency: 'eur',
      },
      { currency: 'eur' },
    )
    const activator = createActivator(EMAIL_ENV, stripe)
    await activator.activateMembershipForStripeSub(sub, 'bundle')

    expect(sentEmails.length).toBe(1)
    expect(sentEmails[0].html).toContain('€23')
    expect(sentEmails[0].html).not.toContain('$25')
  })

  test('a first purchase still gets the welcome email, not the upgrade one', async () => {
    const { stripe, sub } = makeFakeStripe()
    const activator = createActivator(EMAIL_ENV, stripe)
    await activator.activateMembershipForStripeSub(sub, 'bundle')

    expect(sentEmails.length).toBe(1)
    expect(sentEmails[0].subject).toContain('Welcome')
  })

  test('a redelivery that adds no axis sends nothing', async () => {
    // Both axes already carry their markers, so the fan-out is a no-op — and a
    // no-op must not re-announce an upgrade the member made weeks ago.
    const { stripe, sub } = makeFakeStripe({
      sc_subscription_id: '555',
      sc_user_id: '999',
      auth0_user_id: 'auth0|abc',
      circle_provisioned: 'true',
    })
    const activator = createActivator(EMAIL_ENV, stripe)
    await activator.activateMembershipForStripeSub(sub, 'bundle')

    expect(sentEmails.length).toBe(0)
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
