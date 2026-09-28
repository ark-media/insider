// DB-enabled coverage for the 12-month retention-coupon window
// (Membership Change Matrix C3 / D2 / U3).
//
// hasAcceptedRetention (server/lib/cancellation.ts) is the only thing that stops
// a member re-collecting a save-offer / debundle-intro coupon, and it only runs
// when DATABASE_URL is set — which every other route suite leaves unset. This
// file sets it and swaps '@neondatabase/serverless' for an in-memory
// cancellation_survey table: the fake evaluates the window query using the
// month count the SQL itself binds, so the tests prove both that the window is
// 12 months AND that the routes honour it.
//
// Stripe fake + request plumbing follow server/change-tier.test.ts.

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import type { ServerResponse } from 'node:http'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes,
  neonMockModule,
  runMiddleware,
  silenceExpectedConsole,
  type SqlCall,
} from './test-utils'

// ---------------------------------------------------------------------------
// Neon fake: an in-memory cancellation_survey
// ---------------------------------------------------------------------------
type SurveyRow = {
  id: number
  email: string
  offer_outcome: string
  coupon_id: string | null
  created_at: Date
  retained_product?: string | null
}
const sqlCalls: SqlCall[] = []
let surveyRows: SurveyRow[] = []
let nextId = 1

function monthsAgo(n: number): Date {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d
}

function fakeSql(sql: string, values: unknown[]): unknown {
  if (/from cancellation_survey/.test(sql) && /offer_outcome = 'accepted'/.test(sql)) {
    // hasAcceptedRetention: values = [email, months]. Evaluate with the bound
    // month count so a changed window would change the result.
    const [email, months] = values as [string, number]
    const m = sql.match(/make_interval\(months => \?\)/) ? months : NaN
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - m)
    return surveyRows
      .filter(
        (r) =>
          r.email === email &&
          r.offer_outcome === 'accepted' &&
          r.coupon_id !== null &&
          r.created_at.getTime() >= cutoff.getTime(),
      )
      .slice(0, 1)
      .map(() => ({ '?column?': 1 }))
  }
  if (/insert into cancellation_survey/.test(sql)) {
    const [email, , , offer_outcome, coupon_id, , retained_product] = values as [
      string,
      unknown,
      unknown,
      string,
      string | null,
      unknown,
      string | null,
    ]
    const id = nextId++
    surveyRows.push({ id, email, offer_outcome, coupon_id, retained_product, created_at: new Date() })
    return [{ id }]
  }
  return []
}

mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql, values) => fakeSql(sql, values)),
)

// ---------------------------------------------------------------------------
// Stripe fake (trimmed copy of change-tier.test.ts)
// ---------------------------------------------------------------------------
type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []
const NOW_SEC = 1_800_000_000
type Phase = {
  start_date: number
  end_date: number | null
  items: Array<{ price: string; quantity?: number }>
  discounts?: Array<Record<string, unknown>>
}

let existingCustomers: Array<{ id: string; email: string }> = []
let currentSub: Record<string, unknown> | null = null
let schedulePhases: Phase[] = []
let activeCoupons: Array<Record<string, unknown>> = []
const PRODUCT_ENTITLEMENTS: Record<string, string> = {
  prod_ark_plus: 'ark_plus',
  prod_circle: 'circle',
  prod_bundle: 'ark_plus,circle',
}

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return { data: existingCustomers.filter((c) => c.email === args.email) }
    },
  }
  subscriptions = {
    list: async (args: { customer: string }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      return {
        data: currentSub && currentSub.customer === args.customer ? [currentSub] : [],
      }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      return { ...currentSub, id }
    },
    retrieve: async (id: string, args?: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id, args] })
      return { ...currentSub, discounts: [] }
    },
  }
  invoices = {
    createPreview: async (args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'invoices.createPreview', args: [args] })
      return { amount_due: 5200 }
    },
  }
  subscriptionSchedules = {
    create: async (args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptionSchedules.create', args: [args] })
      return { id: 'sched_new' }
    },
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'subscriptionSchedules.retrieve', args: [id] })
      return { id, phases: schedulePhases }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptionSchedules.update', args: [id, args] })
      return { id }
    },
    release: async (id: string) => {
      stripeCalls.push({ method: 'subscriptionSchedules.release', args: [id] })
      return { id }
    },
  }
  products = {
    retrieve: async (id: string) => ({
      id,
      metadata: { entitlements: PRODUCT_ENTITLEMENTS[id] ?? '' },
    }),
  }
  prices = {
    list: async (args: { lookup_keys?: string[] }) => {
      stripeCalls.push({ method: 'prices.list', args: [args] })
      const key = args.lookup_keys?.[0] ?? ''
      const base = key.includes('monthly') ? 800 : 8000
      const currency_options: Record<string, { unit_amount: number }> = {}
      for (const cur of SUPPORTED_CURRENCIES) {
        if (cur !== 'usd') currency_options[cur] = { unit_amount: base }
      }
      const tierKey = key.replace(/_(monthly|yearly)$/, '')
      return {
        data: [
          {
            id: `price_${key}`,
            product: `prod_${tierKey}`,
            unit_amount: base,
            currency: 'usd',
            currency_options,
          },
        ],
      }
    },
    create: async (args: unknown) => {
      stripeCalls.push({ method: 'prices.create', args: [args] })
      return { id: 'price_dyn_1' }
    },
    retrieve: async (id: string, args?: { expand?: string[] }) => {
      const productId = `prod_${id.replace(/^price_/, '').replace(/_(monthly|yearly)$/, '')}`
      return {
        id,
        currency: 'usd',
        currency_options: {},
        recurring: { interval: id.includes('yearly') ? 'year' : 'month' },
        product: args?.expand?.includes('product')
          ? { id: productId, metadata: { entitlements: PRODUCT_ENTITLEMENTS[productId] ?? '' } }
          : productId,
      }
    },
  }
  coupons = {
    list: async (args?: unknown) => {
      stripeCalls.push({ method: 'coupons.list', args: [args] })
      return { data: activeCoupons, has_more: false }
    },
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}

mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

// Static imports AFTER mock.module.
import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'
import { SUPPORTED_CURRENCIES, __resetPriceCacheForTests } from './lib/pricing'
import { RETENTION_WINDOW_MONTHS, hasAcceptedRetention } from './lib/cancellation'

const ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-retention-window-test',
}
const EMAIL = 'member@example.com'

// Keep Resend/Auth0/etc off the network.
const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
afterAll(() => {
  globalThis.fetch = originalFetch
})

async function cookie(): Promise<string> {
  const token = await signSessionToken({ email: EMAIL, roles: [] }, ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const path = url.split('?')[0]!
  const handler = createDevApiHarness(devApiPlugin(ENV)).getHandler(path)
  const res = makeFakeRes()
  await runMiddleware(
    handler,
    makeFakeReq({
      method,
      url,
      body,
      headers: { cookie: await cookie(), origin: ENV.APP_BASE_URL },
    }),
    res as unknown as ServerResponse,
  )
  return res
}

function withSub(tier: 'ark-plus' | 'bundle', amountCents: number) {
  existingCustomers = [{ id: 'cus_1', email: EMAIL }]
  currentSub = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    currency: 'usd',
    schedule: null,
    metadata: {},
    items: {
      data: [
        {
          id: 'si_1',
          price: {
            id: 'price_current',
            unit_amount: amountCents,
            currency: 'usd',
            product: `prod_${tier === 'ark-plus' ? 'ark_plus' : tier}`,
            recurring: { interval: 'month' },
          },
          current_period_end: NOW_SEC + 1000,
        },
      ],
    },
  }
}

const SUPPORTER = {
  id: 'save20',
  valid: true,
  name: 'Stay 20',
  percent_off: 20,
  amount_off: null,
  currency: null,
  duration: 'repeating',
  duration_in_months: 3,
  metadata: { retention_offer: 'true', offer_kind: 'supporter_coupon', plan: 'monthly' },
}
const INTRO = {
  id: 'intro50',
  valid: true,
  name: 'Intro 50',
  percent_off: 50,
  amount_off: null,
  currency: null,
  duration: 'repeating',
  duration_in_months: 6,
  metadata: { retention_offer: 'true', offer_kind: 'debundle_intro' },
}

function acceptedRow(createdAt: Date, couponId: string | null = 'old_coupon') {
  surveyRows.push({
    id: nextId++,
    email: EMAIL,
    offer_outcome: 'accepted',
    coupon_id: couponId,
    created_at: createdAt,
  })
}

const windowQueries = () =>
  sqlCalls.filter((c) => /from cancellation_survey/.test(c.sql) && /accepted/.test(c.sql))

silenceExpectedConsole()
beforeEach(() => {
  sqlCalls.length = 0
  surveyRows = []
  nextId = 1
  stripeCalls.length = 0
  existingCustomers = []
  currentSub = null
  schedulePhases = []
  activeCoupons = []
  __resetPriceCacheForTests()
})

type Offer = { kind: string; couponId?: string | null; percentOff?: number | null }

// ---------------------------------------------------------------------------
// U3 — the window SQL itself
// ---------------------------------------------------------------------------
describe('U3: hasAcceptedRetention runs a 12-month window', () => {
  test('binds a 12-month make_interval over accepted coupon rows only', async () => {
    expect(RETENTION_WINDOW_MONTHS).toBe(12)
    const { neon } = await import('@neondatabase/serverless')
    await hasAcceptedRetention(neon(ENV.DATABASE_URL) as never, EMAIL)
    const q = windowQueries()
    expect(q).toHaveLength(1)
    expect(q[0]!.sql).toContain('make_interval(months => ?)')
    expect(q[0]!.sql).toContain('created_at >= now() -')
    expect(q[0]!.sql).toContain("offer_outcome = 'accepted'")
    expect(q[0]!.sql).toContain('coupon_id is not null')
    expect(q[0]!.values).toEqual([EMAIL, 12])
  })

  test('11 months ago blocks, 13 months ago does not, a coupon-less accept never does', async () => {
    const { neon } = await import('@neondatabase/serverless')
    const sql = neon(ENV.DATABASE_URL) as never
    acceptedRow(monthsAgo(11))
    expect(await hasAcceptedRetention(sql, EMAIL)).toBe(true)
    surveyRows = []
    acceptedRow(monthsAgo(13))
    expect(await hasAcceptedRetention(sql, EMAIL)).toBe(false)
    surveyRows = []
    acceptedRow(monthsAgo(1), null)
    expect(await hasAcceptedRetention(sql, EMAIL)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C3 — save offers + accept for an Ark+ monthly member
// ---------------------------------------------------------------------------
describe('C3: save offers respect the 12-month window (Ark+ monthly)', () => {
  test('C3a: coupon accepted 3 months ago → coupon offers hidden, annual switch still offered', async () => {
    withSub('ark-plus', 800)
    activeCoupons = [SUPPORTER]
    acceptedRow(monthsAgo(3))
    const res = await call('GET', '/api/stripe/save-offers?intent=cancel-ark-plus')
    expect(res.statusCode).toBe(200)
    const { offers } = res.__json() as { offers: Offer[] }
    expect(offers.map((o) => o.kind)).toEqual(['annual_switch'])
    expect(offers[0]!.couponId).toBeNull()
    expect(offers[0]!.percentOff).toBeNull()
    expect(windowQueries()).toHaveLength(1)
    expect(windowQueries()[0]!.values).toEqual([EMAIL, 12])
  })

  test('C3b: coupon accepted 13 months ago → supporter coupon offered again', async () => {
    withSub('ark-plus', 800)
    activeCoupons = [SUPPORTER]
    acceptedRow(monthsAgo(13))
    const res = await call('GET', '/api/stripe/save-offers?intent=cancel-ark-plus')
    const { offers } = res.__json() as { offers: Offer[] }
    expect(offers.map((o) => o.kind)).toEqual(['annual_switch', 'supporter_coupon'])
    expect(offers.find((o) => o.kind === 'supporter_coupon')!.couponId).toBe('save20')
    expect(windowQueries()).toHaveLength(1)
  })

  test('C3b control: no prior acceptance → supporter coupon offered', async () => {
    withSub('ark-plus', 800)
    activeCoupons = [SUPPORTER]
    const res = await call('GET', '/api/stripe/save-offers?intent=cancel-ark-plus')
    const { offers } = res.__json() as { offers: Offer[] }
    expect(offers.map((o) => o.kind)).toContain('supporter_coupon')
  })

  test('C3c: accepting a coupon inside the window is refused, nothing attached or recorded', async () => {
    withSub('ark-plus', 800)
    activeCoupons = [SUPPORTER]
    acceptedRow(monthsAgo(3))
    const res = await call('POST', '/api/stripe/accept-save-offer', {
      intent: 'cancel-ark-plus',
      kind: 'supporter_coupon',
    })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { error: string }).error).toBe('Save offer already used recently.')
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(false)
    expect(sqlCalls.some((c) => /insert into cancellation_survey/.test(c.sql))).toBe(false)
    expect(surveyRows).toHaveLength(1)
  })

  test('C3c control: outside the window the accept lands and writes an accepted row that spends it', async () => {
    withSub('ark-plus', 800)
    activeCoupons = [SUPPORTER]
    acceptedRow(monthsAgo(13))
    const res = await call('POST', '/api/stripe/accept-save-offer', {
      intent: 'cancel-ark-plus',
      kind: 'supporter_coupon',
    })
    expect(res.statusCode).toBe(200)
    const upd = stripeCalls.find((c) => c.method === 'subscriptions.update')
    expect((upd!.args[1] as { discounts: unknown[] }).discounts).toEqual([{ coupon: 'save20' }])
    const fresh = surveyRows.at(-1)!
    expect(fresh).toMatchObject({ offer_outcome: 'accepted', coupon_id: 'save20' })

    // Re-entering immediately is now refused.
    const again = await call('POST', '/api/stripe/accept-save-offer', {
      intent: 'cancel-ark-plus',
      kind: 'supporter_coupon',
    })
    expect(again.statusCode).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// D2 — debundle intro coupon spends the same window
// ---------------------------------------------------------------------------
describe('D2: debundle intro coupon and the retention window', () => {
  function stageDebundle() {
    withSub('bundle', 2000)
    activeCoupons = [INTRO]
    schedulePhases = [
      {
        start_date: NOW_SEC - 100,
        end_date: NOW_SEC + 1000,
        items: [{ price: 'price_bundle_monthly', quantity: 1 }],
      },
    ]
  }
  const debundle = () =>
    call('POST', '/api/stripe/change-tier', {
      tier: 'ark-plus',
      plan: 'monthly',
      retained_product: 'kept-ark-plus',
    })
  const lastSchedulePhases = () => {
    const u = stripeCalls.filter((c) => c.method === 'subscriptionSchedules.update').at(-1)
    return (u!.args[1] as { phases: Array<{ discounts?: unknown[] }> }).phases
  }

  test('D2: window free → intro coupon on the new phase and an accepted row is written', async () => {
    stageDebundle()
    const res = await debundle()
    expect(res.statusCode).toBe(200)
    expect((res.__json() as { timing: string }).timing).toBe('period_end')
    const phases = lastSchedulePhases()
    expect(phases).toHaveLength(2)
    expect(phases[1]!.discounts).toEqual([{ coupon: 'intro50' }])
    expect(phases[0]!.discounts).toBeUndefined()

    expect(surveyRows).toHaveLength(1)
    expect(surveyRows[0]).toMatchObject({
      email: EMAIL,
      offer_outcome: 'accepted',
      coupon_id: 'intro50',
      retained_product: 'kept-ark-plus',
    })
    expect((res.__json() as { survey_id: unknown }).survey_id).toBe(surveyRows[0]!.id)
    expect(windowQueries()[0]!.values).toEqual([EMAIL, 12])
  })

  test('D2: window used (accept 3 months ago) → no intro coupon, row carries no coupon', async () => {
    stageDebundle()
    acceptedRow(monthsAgo(3))
    const res = await debundle()
    expect(res.statusCode).toBe(200)
    const phases = lastSchedulePhases()
    expect(phases[1]!.discounts).toBeUndefined()
    const written = surveyRows.at(-1)!
    expect(written.coupon_id).toBeNull()
    expect(written.offer_outcome).not.toBe('accepted')
    expect(stripeCalls.some((c) => c.method === 'coupons.list')).toBe(false)
  })

  test('D2: the intro spends the window — a second debundle right after gets no coupon', async () => {
    stageDebundle()
    await debundle()
    expect(lastSchedulePhases()[1]!.discounts).toEqual([{ coupon: 'intro50' }])
    const again = await debundle()
    expect(again.statusCode).toBe(200)
    expect(lastSchedulePhases()[1]!.discounts).toBeUndefined()
  })

  test('D2: window expired (accept 13 months ago) → intro coupon granted again', async () => {
    stageDebundle()
    acceptedRow(monthsAgo(13))
    await debundle()
    expect(lastSchedulePhases()[1]!.discounts).toEqual([{ coupon: 'intro50' }])
  })
})
