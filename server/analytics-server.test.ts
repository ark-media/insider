/// <reference types="bun" />
// Unit tests for the server-side analytics client (server/lib/analytics-server.ts)
// and the shared attribution contract it reads.
//
// The load-bearing property here is that this module CANNOT break checkout or
// the webhook. Every caller runs after the entitlement work has committed, so a
// throw would 500 the webhook and put Stripe into a retry loop over a metrics
// problem. Several cases below exist only to pin that.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import {
  attributionFromMetadata,
  captureServerEvent,
  emailDistinctId,
} from './lib/analytics-server'
import { sanitizeAttribution, MAX_ATTRIBUTION_VALUE_LEN } from '../shared/attribution'
import { silenceExpectedConsole } from './test-utils'

const ENV = { POSTHOG_API_KEY: 'phc_test', VERCEL_ENV: 'production' }

const originalFetch = globalThis.fetch
type Captured = { url: string; body: Record<string, unknown> }
let calls: Captured[] = []
let respond: () => Response | Promise<Response> = () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  calls.push({
    url: typeof input === 'string' ? input : input.toString(),
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  })
  return respond()
}) as typeof fetch

// The soft-fail cases below deliberately log; keep the suite output readable.
silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  calls = []
  respond = () => new Response('{}', { status: 200 })
})

const props = (): Record<string, unknown> =>
  calls[0]?.body.properties as Record<string, unknown>

describe('emailDistinctId', () => {
  // The exact value the browser's hashEmail() produces for the same address.
  // If these two ever diverge, a member's checkout intent and their confirmed
  // revenue land on two different PostHog persons and every funnel silently
  // breaks — so it is pinned to a literal rather than recomputed here.
  test('matches the browser hash: lowercase-trimmed SHA-256 hex', () => {
    expect(emailDistinctId('hannah@example.com')).toBe(
      'cb53b7a9b00c0558fce2bc9b436789e2c48c7e8ef05b389277519bcf53b4f0a7',
    )
  })

  test('normalizes case and surrounding whitespace before hashing', () => {
    expect(emailDistinctId('  Hannah@Example.COM  ')).toBe(
      emailDistinctId('hannah@example.com'),
    )
  })

  test('returns empty string for a missing email rather than hashing ""', () => {
    expect(emailDistinctId(null)).toBe('')
    expect(emailDistinctId(undefined)).toBe('')
    expect(emailDistinctId('')).toBe('')
  })
})

describe('captureServerEvent', () => {
  test('posts to the PostHog capture endpoint with the documented body shape', async () => {
    const ok = await captureServerEvent(ENV, {
      event: 'subscription_started_confirmed',
      distinctId: 'hash123',
      properties: { tier: 'bundle', plan: 'yearly', amount_cents: 12000, currency: 'usd' },
    })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://us.i.posthog.com/i/v0/e/')
    expect(calls[0]!.body.api_key).toBe('phc_test')
    expect(calls[0]!.body.event).toBe('subscription_started_confirmed')
    expect(calls[0]!.body.distinct_id).toBe('hash123')
    expect(typeof calls[0]!.body.timestamp).toBe('string')
    expect(props().tier).toBe('bundle')
    expect(props().amount_cents).toBe(12000)
  })

  test('tags every event as server-emitted, with its environment and join key', () => {
    // These three are what let a dashboard tell the server-confirmed conversion
    // apart from the browser's optimistic checkout_succeeded, keep Stripe
    // test-mode traffic out of the real funnel, and stitch this person across
    // systems.
    return captureServerEvent(ENV, {
      event: 'member_provisioned',
      distinctId: 'hash123',
      properties: {
        tier: 'ark-plus',
        plan: 'monthly',
        amount_cents: 599,
        currency: 'usd',
        axes: 'ark-plus',
      },
    }).then(() => {
      expect(props().source).toBe('server')
      expect(props().environment).toBe('production')
      expect(props().email_sha256).toBe('hash123')
    })
  })

  test('merges attribution read back off Stripe metadata into the properties', async () => {
    await captureServerEvent(ENV, {
      event: 'member_provisioned',
      distinctId: 'hash123',
      properties: {
        tier: 'ark-plus',
        plan: 'yearly',
        amount_cents: 5999,
        currency: 'usd',
        axes: 'ark-plus',
      },
      attribution: {
        first_touch_source: 'cmb-ep412',
        first_touch_medium: 'referral',
      },
    })
    // The point of the whole forwarding chain: the confirmed conversion knows
    // which channel produced the member, with no browser session to rejoin.
    expect(props().first_touch_source).toBe('cmb-ep412')
    expect(props().first_touch_medium).toBe('referral')
  })

  test('is a silent no-op when POSTHOG_API_KEY is unset', async () => {
    const ok = await captureServerEvent(
      {},
      {
        event: 'gift_redeemed_confirmed',
        distinctId: 'hash123',
        properties: { tier: 'ark-plus', plan: '1yr', applied: 'membership' },
      },
    )
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('skips (rather than sends an unattributable event) with no distinct_id', async () => {
    const ok = await captureServerEvent(ENV, {
      event: 'gift_redeemed_confirmed',
      distinctId: '',
      properties: { tier: 'ark-plus', plan: '1yr', applied: 'membership' },
    })
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('soft-fails on a non-2xx from PostHog', async () => {
    respond = () => new Response('nope', { status: 503 })
    const ok = await captureServerEvent(ENV, {
      event: 'member_provisioned',
      distinctId: 'hash123',
      properties: {
        tier: 'ark-plus',
        plan: 'monthly',
        amount_cents: 599,
        currency: 'usd',
        axes: 'ark-plus',
      },
    })
    expect(ok).toBe(false)
  })

  test('soft-fails when the request throws — a PostHog outage must not 500 the webhook', async () => {
    respond = () => {
      throw new Error('network down')
    }
    const ok = await captureServerEvent(ENV, {
      event: 'member_provisioned',
      distinctId: 'hash123',
      properties: {
        tier: 'ark-plus',
        plan: 'monthly',
        amount_cents: 599,
        currency: 'usd',
        axes: 'ark-plus',
      },
    })
    expect(ok).toBe(false)
  })

  test('falls back to the browser key so setting only VITE_POSTHOG_KEY still lights up the server', async () => {
    // PostHog uses one project key for both capture APIs. Requiring a second
    // variable would leave server-side revenue dark the day someone sets only
    // the VITE_ one — the exact failure mode this workstream exists to fix.
    const ok = await captureServerEvent(
      { VITE_POSTHOG_KEY: 'phc_browser', VITE_POSTHOG_HOST: 'https://eu.i.posthog.com' },
      {
        event: 'gift_redeemed_confirmed',
        distinctId: 'hash123',
        properties: { tier: 'ark-plus', plan: '1yr', applied: 'membership' },
      },
    )
    expect(ok).toBe(true)
    expect(calls[0]!.url).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(calls[0]!.body.api_key).toBe('phc_browser')
  })

  test('an explicit POSTHOG_API_KEY overrides the browser key', async () => {
    await captureServerEvent(
      { POSTHOG_API_KEY: 'phc_server', VITE_POSTHOG_KEY: 'phc_browser' },
      {
        event: 'gift_redeemed_confirmed',
        distinctId: 'hash123',
        properties: { tier: 'ark-plus', plan: '1yr', applied: 'membership' },
      },
    )
    expect(calls[0]!.body.api_key).toBe('phc_server')
  })

  test('honors POSTHOG_HOST and tolerates a trailing slash', async () => {
    await captureServerEvent(
      { POSTHOG_API_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com/' },
      {
        event: 'gift_redeemed_confirmed',
        distinctId: 'hash123',
        properties: { tier: 'circle', plan: '6mo', applied: 'extended' },
      },
    )
    expect(calls[0]!.url).toBe('https://eu.i.posthog.com/i/v0/e/')
  })
})

describe('attributionFromMetadata', () => {
  test('picks only attribution keys off a Stripe metadata bag', () => {
    expect(
      attributionFromMetadata({
        tier: 'bundle',
        plan: 'yearly',
        sc_subscription_id: '123',
        first_touch_source: 'newsletter',
        last_touch_medium: 'referral',
      }),
    ).toEqual({ first_touch_source: 'newsletter', last_touch_medium: 'referral' })
  })

  test('returns an empty object for missing or empty metadata', () => {
    expect(attributionFromMetadata(null)).toEqual({})
    expect(attributionFromMetadata(undefined)).toEqual({})
    expect(attributionFromMetadata({ tier: 'bundle' })).toEqual({})
  })
})

describe('sanitizeAttribution', () => {
  // The browser is the only source of this data, so this allowlist is what
  // stops a crafted checkout body writing arbitrary keys into Stripe metadata.
  test('drops keys that are not part of the attribution contract', () => {
    expect(
      sanitizeAttribution({
        first_touch_source: 'google',
        sc_subscription_id: 'injected',
        tier: 'bundle',
        __proto__: 'nope',
      }),
    ).toEqual({ first_touch_source: 'google' })
  })

  test('caps value length so a hostile utm_campaign cannot break session creation', () => {
    const out = sanitizeAttribution({ first_touch_campaign: 'x'.repeat(5000) })
    expect(out.first_touch_campaign).toHaveLength(MAX_ATTRIBUTION_VALUE_LEN)
  })

  test('drops empty and non-string values rather than stamping noise', () => {
    expect(
      sanitizeAttribution({
        first_touch_source: '   ',
        first_touch_medium: 42,
        first_touch_campaign: null,
        last_touch_source: '  x  ',
      }),
    ).toEqual({ last_touch_source: 'x' })
  })

  test('returns {} for non-object input', () => {
    expect(sanitizeAttribution(null)).toEqual({})
    expect(sanitizeAttribution('first_touch_source=google')).toEqual({})
    expect(sanitizeAttribution(['first_touch_source'])).toEqual({})
  })
})
