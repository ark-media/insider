// Unit tests for server/lib/beehiiv-sync.ts.
//
// `fetch` is monkey-patched per test so Beehiiv calls never leave the
// process. The Neon SQL client is a small stub that records every tagged-
// template call so each test can assert what would have been written.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { silenceExpectedConsole } from './test-utils'
import {
  applyPreferences,
  clearNewsletterRefreshCache,
  downgradeToFree,
  ensureSubscribedWithPremium,
  isReceivingEmails,
  refreshSubscriptionFromBeehiiv,
  syncSubscriberName,
  tryPush,
} from './lib/beehiiv-sync'
import type { Sql } from './lib/db'

const PUB_ID = 'pub_test-1234'
const PREMIUM_TIER = 'pt_premium_xyz'

const BASE_ENV = {
  BEEHIIV_API_KEY: 'bk_test',
  BEEHIIV_PUBLICATION_ID_ARK_DAILY: PUB_ID,
  BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER: PUB_ID,
  BEEHIIV_PREMIUM_TIER_ID: PREMIUM_TIER,
} as Record<string, string>

// --- fetch stub ----------------------------------------------------------

type FetchCall = { url: string; method: string; body: unknown }
type FetchHandler = (call: FetchCall) => Response | Promise<Response>

const originalFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []
let fetchHandler: FetchHandler = () =>
  jsonRes(500, { unexpected: 'no handler' })

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  clearNewsletterRefreshCache()
  fetchCalls = []
  fetchHandler = () => jsonRes(500, { unexpected: 'no handler' })
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : input.toString()
    let parsed: unknown = undefined
    if (init?.body && typeof init.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = init.body
      }
    }
    const call: FetchCall = { url, method: init?.method ?? 'GET', body: parsed }
    fetchCalls.push(call)
    return fetchHandler(call)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

silenceExpectedConsole()

// --- SQL stub ------------------------------------------------------------

// Records each tag-template invocation as a single string plus the
// substituted values, so tests can assert on writes without coupling to the
// exact SQL we render.
type SqlCall = { sql: string; values: unknown[] }

function makeSqlStub(rowsByQuery: (sql: string) => unknown[]): {
  sql: Sql
  calls: SqlCall[]
} {
  const calls: SqlCall[] = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const merged = strings.join('?')
    calls.push({ sql: merged, values })
    return Promise.resolve(rowsByQuery(merged))
  }) as unknown as Sql
  return { sql: fn, calls }
}

// Default: empty result set for every SELECT (no existing local row).
const emptyRows = () => [] as unknown[]

// --- Beehiiv response factories ------------------------------------------

function beehiivSub(opts: {
  id?: string
  email?: string
  status?: string
  tier?: 'free' | 'premium'
  premiumTierNames?: string[]
}): unknown {
  return {
    data: {
      id: opts.id ?? 'sub_abc',
      email: opts.email ?? 'reader@example.com',
      status: opts.status ?? 'active',
      subscription_tier: opts.tier ?? 'free',
      subscription_premium_tier_names: opts.premiumTierNames ?? [],
    },
  }
}

// ============================================================================
// ensureSubscribedWithPremium
// ============================================================================

describe('ensureSubscribedWithPremium', () => {
  test('skips when not configured', async () => {
    const { sql } = makeSqlStub(emptyRows)
    await ensureSubscribedWithPremium({ env: {}, sql }, 'a@x.com')
    expect(fetchCalls).toHaveLength(0)
  })

  test('skips when premium tier id not set, logs error', async () => {
    const { sql } = makeSqlStub(emptyRows)
    const env = { ...BASE_ENV }
    delete env.BEEHIIV_PREMIUM_TIER_ID
    await ensureSubscribedWithPremium({ env, sql }, 'a@x.com')
    expect(fetchCalls).toHaveLength(0)
  })

  test('creates with premium tier when no existing record', async () => {
    const { sql, calls: sqlCalls } = makeSqlStub(emptyRows)
    fetchHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        return jsonRes(404, { error: 'not found' })
      }
      if (method === 'POST' && url.endsWith(`/publications/${PUB_ID}/subscriptions`)) {
        return jsonRes(
          200,
          beehiivSub({
            id: 'sub_new',
            email: 'a@x.com',
            tier: 'premium',
            premiumTierNames: ['Premium'],
          }),
        )
      }
      return jsonRes(500, { unexpected: url })
    }
    await ensureSubscribedWithPremium({ env: BASE_ENV, sql }, 'a@x.com')
    const post = fetchCalls.find((c) => c.method === 'POST')
    expect(post).toBeDefined()
    expect(post!.body).toMatchObject({
      email: 'a@x.com',
      reactivate_existing: true,
      premium_tier_ids: [PREMIUM_TIER],
    })
    // upsert ran
    expect(sqlCalls.some((c) => c.sql.includes('insert into beehiiv_subscription'))).toBe(true)
  })

  test('upgrades when existing record is free', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        return jsonRes(200, beehiivSub({ id: 'sub_old', tier: 'free' }))
      }
      if (method === 'PUT' && url.includes('/subscriptions/sub_old')) {
        return jsonRes(
          200,
          beehiivSub({ id: 'sub_old', tier: 'premium', premiumTierNames: ['Premium'] }),
        )
      }
      return jsonRes(500, { unexpected: url })
    }
    await ensureSubscribedWithPremium({ env: BASE_ENV, sql }, 'reader@example.com')
    const put = fetchCalls.find((c) => c.method === 'PUT')
    expect(put).toBeDefined()
    expect(put!.body).toEqual({ premium_tier_ids: [PREMIUM_TIER] })
  })

  test('re-applies tier when existing record is inactive', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method, url }) => {
      if (method === 'GET') {
        return jsonRes(
          200,
          beehiivSub({
            id: 'sub_dormant',
            status: 'inactive',
            tier: 'premium',
            premiumTierNames: ['Premium'],
          }),
        )
      }
      if (method === 'PUT' && url.includes('/subscriptions/sub_dormant')) {
        return jsonRes(
          200,
          beehiivSub({
            id: 'sub_dormant',
            status: 'active',
            tier: 'premium',
            premiumTierNames: ['Premium'],
          }),
        )
      }
      return jsonRes(500, { unexpected: url })
    }
    await ensureSubscribedWithPremium({ env: BASE_ENV, sql }, 'reader@example.com')
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  test('no PUT when already premium and active', async () => {
    const { sql, calls: sqlCalls } = makeSqlStub(emptyRows)
    fetchHandler = ({ method }) => {
      if (method === 'GET') {
        return jsonRes(
          200,
          beehiivSub({
            tier: 'premium',
            premiumTierNames: ['Premium'],
            status: 'active',
          }),
        )
      }
      return jsonRes(500, { unexpected: 'should not reach' })
    }
    await ensureSubscribedWithPremium({ env: BASE_ENV, sql }, 'reader@example.com')
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    // Still upserts to refresh local mirror.
    expect(sqlCalls.some((c) => c.sql.includes('insert into'))).toBe(true)
  })

  test('throws when Beehiiv response is missing id (boundary check)', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ url, method }) => {
      if (method === 'GET') return jsonRes(404, {})
      if (method === 'POST') return jsonRes(200, { data: { email: 'a@x.com' } })
      return jsonRes(500, { unexpected: url })
    }
    await expect(
      ensureSubscribedWithPremium({ env: BASE_ENV, sql }, 'a@x.com'),
    ).rejects.toThrow(/missing id/)
  })
})

// ============================================================================
// downgradeToFree
// ============================================================================

describe('downgradeToFree', () => {
  test('no-op when no existing record', async () => {
    const { sql, calls: sqlCalls } = makeSqlStub(emptyRows)
    fetchHandler = ({ method }) => {
      if (method === 'GET') return jsonRes(404, {})
      return jsonRes(500, { unexpected: 'should not reach' })
    }
    await downgradeToFree({ env: BASE_ENV, sql }, 'a@x.com')
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(sqlCalls.some((c) => c.sql.includes('insert into'))).toBe(false)
  })

  test('no PUT when already free', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method }) => {
      if (method === 'GET') return jsonRes(200, beehiivSub({ tier: 'free' }))
      return jsonRes(500, { unexpected: 'should not reach' })
    }
    await downgradeToFree({ env: BASE_ENV, sql }, 'a@x.com')
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  test('PUT tier=free when has premium', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method, url }) => {
      if (method === 'GET') {
        return jsonRes(
          200,
          beehiivSub({ id: 'sub_paid', tier: 'premium', premiumTierNames: ['Premium'] }),
        )
      }
      if (method === 'PUT' && url.includes('/subscriptions/sub_paid')) {
        return jsonRes(200, beehiivSub({ id: 'sub_paid', tier: 'free' }))
      }
      return jsonRes(500, { unexpected: url })
    }
    await downgradeToFree({ env: BASE_ENV, sql }, 'a@x.com')
    const put = fetchCalls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ tier: 'free' })
  })
})

// ============================================================================
// syncSubscriberName
// ============================================================================

describe('syncSubscriberName', () => {
  test('writes both parts and reports that it wrote', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method }) => {
      if (method === 'GET') return jsonRes(200, beehiivSub({ id: 'sub_1' }))
      return jsonRes(200, beehiivSub({ id: 'sub_1' }))
    }
    const wrote = await syncSubscriberName({ env: BASE_ENV, sql }, 'a@x.com', {
      first: 'Hannah',
      last: 'Waxman',
    })
    expect(wrote).toBe(true)
    expect(fetchCalls.find((c) => c.method === 'PUT')?.body).toEqual({
      custom_fields: [
        { name: 'First Name', value: 'Hannah' },
        { name: 'Last Name', value: 'Waxman' },
      ],
    })
  })

  test('null clears the surname; undefined leaves it alone', async () => {
    // Only the account save can express a deliberate clear. A harvested name
    // that simply lacks a surname must not delete one Beehiiv already holds.
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = () => jsonRes(200, beehiivSub({ id: 'sub_1' }))

    await syncSubscriberName({ env: BASE_ENV, sql }, 'a@x.com', {
      first: 'Hannah',
      last: null,
    })
    expect(fetchCalls.find((c) => c.method === 'PUT')?.body).toEqual({
      custom_fields: [
        { name: 'First Name', value: 'Hannah' },
        { name: 'Last Name', delete: true },
      ],
    })

    fetchCalls = []
    await syncSubscriberName({ env: BASE_ENV, sql }, 'a@x.com', {
      first: 'Hannah',
      last: undefined,
    })
    expect(fetchCalls.find((c) => c.method === 'PUT')?.body).toEqual({
      custom_fields: [{ name: 'First Name', value: 'Hannah' }],
    })
  })

  test('a no-op reports false so callers do not tally it', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = () => jsonRes(404, {})
    // No Beehiiv record for this reader.
    expect(
      await syncSubscriberName({ env: BASE_ENV, sql }, 'a@x.com', { first: 'Hannah' }),
    ).toBe(false)
    // Nothing worth writing.
    expect(await syncSubscriberName({ env: BASE_ENV, sql }, 'a@x.com', {})).toBe(false)
    // Beehiiv not configured at all.
    expect(
      await syncSubscriberName({ env: {}, sql }, 'a@x.com', { first: 'Hannah' }),
    ).toBe(false)
  })

  test('mirrors the by_email read, not the custom-fields response', async () => {
    // The PUT carries only custom_fields, so a response that omits the tier
    // fields infers has_premium=false — persisting it would downgrade a paying
    // member in the mirror and light up the reconciler.
    const { sql, calls: sqlCalls } = makeSqlStub(emptyRows)
    fetchHandler = ({ method }) => {
      if (method === 'GET') {
        return jsonRes(
          200,
          beehiivSub({ id: 'sub_paid', tier: 'premium', premiumTierNames: ['Premium'] }),
        )
      }
      // Beehiiv echoes the record without the tier fields.
      return jsonRes(200, { data: { id: 'sub_paid', email: 'a@x.com', status: 'active' } })
    }
    await syncSubscriberName({ env: BASE_ENV, sql }, 'a@x.com', { first: 'Hannah' })
    const upsert = sqlCalls.find((c) => c.sql.includes('insert into'))
    expect(upsert).toBeDefined()
    expect(upsert!.values).toContain(true)
  })
})

// ============================================================================
// applyPreferences
// ============================================================================

describe('applyPreferences', () => {
  test('combined update sends both fields in one PUT', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method, url }) => {
      if (method === 'GET') {
        return jsonRes(200, beehiivSub({ id: 'sub_z', tier: 'free' }))
      }
      if (method === 'PUT' && url.includes('/subscriptions/sub_z')) {
        return jsonRes(
          200,
          beehiivSub({ id: 'sub_z', tier: 'premium', premiumTierNames: ['Premium'] }),
        )
      }
      return jsonRes(500, { unexpected: url })
    }
    await applyPreferences({ env: BASE_ENV, sql }, 'a@x.com', {
      free: true,
      premium: true,
    })
    const puts = fetchCalls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({
      unsubscribe: false,
      premium_tier_ids: [PREMIUM_TIER],
    })
  })

  test('downgrade premium with single PUT', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method, url }) => {
      if (method === 'GET') {
        return jsonRes(
          200,
          beehiivSub({ id: 'sub_p', tier: 'premium', premiumTierNames: ['Premium'] }),
        )
      }
      if (method === 'PUT' && url.includes('/subscriptions/sub_p')) {
        return jsonRes(200, beehiivSub({ id: 'sub_p', tier: 'free' }))
      }
      return jsonRes(500, { unexpected: url })
    }
    await applyPreferences({ env: BASE_ENV, sql }, 'a@x.com', { premium: false })
    const puts = fetchCalls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({ tier: 'free' })
  })

  test('unsubscribe (free:false) sends unsubscribe:true', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method, url }) => {
      if (method === 'GET') return jsonRes(200, beehiivSub({ id: 'sub_q' }))
      if (method === 'PUT' && url.includes('/subscriptions/sub_q')) {
        return jsonRes(200, beehiivSub({ id: 'sub_q', status: 'inactive' }))
      }
      return jsonRes(500, { unexpected: url })
    }
    await applyPreferences({ env: BASE_ENV, sql }, 'a@x.com', { free: false })
    const put = fetchCalls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ unsubscribe: true })
  })

  test('no-op when no existing record and prefs are all off', async () => {
    const { sql, calls: sqlCalls } = makeSqlStub(emptyRows)
    fetchHandler = ({ method }) => {
      if (method === 'GET') return jsonRes(404, {})
      return jsonRes(500, { unexpected: 'should not reach' })
    }
    const result = await applyPreferences({ env: BASE_ENV, sql }, 'a@x.com', {
      free: false,
      premium: false,
    })
    expect(result).toBeNull()
    expect(fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(sqlCalls.some((c) => c.sql.includes('insert into'))).toBe(false)
  })

  test('creates with premium tier when no existing record and premium:true', async () => {
    const { sql } = makeSqlStub(emptyRows)
    fetchHandler = ({ method, url }) => {
      if (method === 'GET') return jsonRes(404, {})
      if (method === 'POST' && url.endsWith(`/publications/${PUB_ID}/subscriptions`)) {
        return jsonRes(
          200,
          beehiivSub({ id: 'sub_x', tier: 'premium', premiumTierNames: ['Premium'] }),
        )
      }
      return jsonRes(500, { unexpected: url })
    }
    await applyPreferences({ env: BASE_ENV, sql }, 'a@x.com', {
      free: true,
      premium: true,
    })
    const post = fetchCalls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({
      premium_tier_ids: [PREMIUM_TIER],
    })
  })
})

// ============================================================================
// isReceivingEmails
// ============================================================================

describe('isReceivingEmails', () => {
  test('active and pending count as receiving', () => {
    expect(isReceivingEmails('active')).toBe(true)
    expect(isReceivingEmails('pending')).toBe(true)
  })

  test('inactive and paused do not', () => {
    expect(isReceivingEmails('inactive')).toBe(false)
    expect(isReceivingEmails('paused')).toBe(false)
  })
})

// ============================================================================
// refreshSubscriptionFromBeehiiv
// ============================================================================

describe('refreshSubscriptionFromBeehiiv', () => {
  test('deletes local row when Beehiiv returns 404', async () => {
    fetchHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        return jsonRes(404, {})
      }
      return jsonRes(500, { unexpected: url })
    }
    const { sql, calls } = makeSqlStub(emptyRows)
    const row = await refreshSubscriptionFromBeehiiv(
      { env: BASE_ENV, sql },
      'gone@example.com',
    )
    expect(row).toBeNull()
    expect(
      calls.some((c) => c.sql.includes('delete from beehiiv_subscription')),
    ).toBe(true)
    expect(fetchCalls).toHaveLength(1)
  })

  test('falls back to local mirror when Beehiiv errors', async () => {
    fetchHandler = () => jsonRes(503, { error: 'upstream' })
    const { sql, calls } = makeSqlStub((sql) => {
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 'local@example.com',
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_local',
            status: 'active',
            has_premium: false,
            updated_at: new Date().toISOString(),
          },
        ]
      }
      return []
    })
    const row = await refreshSubscriptionFromBeehiiv(
      { env: BASE_ENV, sql },
      'local@example.com',
    )
    expect(row?.beehiivSubscriptionId).toBe('sub_local')
    expect(
      calls.some((c) => c.sql.includes('delete from beehiiv_subscription')),
    ).toBe(false)
  })

  test('uses cache on second call within TTL', async () => {
    let lookups = 0
    fetchHandler = ({ url, method }) => {
      if (method === 'GET' && url.includes('/subscriptions/by_email/')) {
        lookups += 1
        return jsonRes(200, beehiivSub({ id: 'sub_c', email: 'cache@example.com' }))
      }
      return jsonRes(500, { unexpected: url })
    }
    const { sql } = makeSqlStub((sql) => {
      if (sql.includes('insert into beehiiv_subscription')) return []
      if (sql.includes('select') && sql.includes('beehiiv_subscription')) {
        return [
          {
            email: 'cache@example.com',
            publication_id: PUB_ID,
            beehiiv_subscription_id: 'sub_c',
            status: 'active',
            has_premium: false,
            updated_at: new Date().toISOString(),
          },
        ]
      }
      return []
    })
    const deps = { env: BASE_ENV, sql }
    await refreshSubscriptionFromBeehiiv(deps, 'cache@example.com')
    await refreshSubscriptionFromBeehiiv(deps, 'cache@example.com')
    expect(lookups).toBe(1)
  })
})

// ============================================================================
// tryPush
// ============================================================================

describe('tryPush', () => {
  test('returns true on success', async () => {
    const ok = await tryPush('label', async () => {})
    expect(ok).toBe(true)
  })

  test('returns false and swallows on throw', async () => {
    const ok = await tryPush('label', async () => {
      throw new Error('boom')
    })
    expect(ok).toBe(false)
  })
})

