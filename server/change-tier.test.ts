// Unit tests for POST /api/stripe/change-tier — the in-app tier/plan/PWYC switch
// (task 14). Focuses on the two behaviours most easily gotten wrong:
//
//   1. A period-end change to an ABOVE-FLOOR PWYC amount must bill that amount
//      (inline price_data on the schedule phase), not silently fall back to the
//      catalog floor price while Neon records the higher number.
//   2. When the subscription already carries a pending change (a 2-phase
//      schedule), the rebuild must preserve the phase covering NOW as phase 0 —
//      taking the last phase would grab the future one and drop the live period.
//
// Harness mirrors my-subscription.test.ts (mock.module('stripe') + a signed
// session cookie driving the registered middleware). No DATABASE_URL, so the
// membership pending writes are skipped — this exercises the Stripe side.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

type StripeCall = { method: string; args: unknown[] }
const stripeCalls: StripeCall[] = []

const NOW_SEC = 1_800_000_000 // fixed, comfortably in range for phase math
type Phase = {
  start_date: number
  end_date: number | null
  items: Array<{ price: string; quantity?: number }>
}

// Per-test config.
let existingCustomers: Array<{ id: string; email: string }> = []
let currentSub: Record<string, unknown> | null = null
let schedulePhases: Phase[] = []
let productEntitlements: Record<string, string> = {}

class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string; limit: number }) => {
      stripeCalls.push({ method: 'customers.list', args: [args] })
      return { data: existingCustomers.filter((c) => c.email === args.email) }
    },
  }
  subscriptions = {
    list: async (args: { customer: string; status?: string; limit?: number }) => {
      stripeCalls.push({ method: 'subscriptions.list', args: [args] })
      const match =
        currentSub && (currentSub.customer as string) === args.customer ? [currentSub] : []
      return { data: match }
    },
    update: async (id: string, args: Record<string, unknown>) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, args] })
      return { id }
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
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'products.retrieve', args: [id] })
      return { id, metadata: { entitlements: productEntitlements[id] ?? '' } }
    },
  }
  prices = {
    // resolveCatalogPrice: floor 800 (monthly) with currency_options for every
    // supported currency, product prod_<tier>.
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
import { SUPPORTED_CURRENCIES } from './lib/pricing'

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

const BASE_ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
}

const PATH = '/api/stripe/change-tier'

function getHandler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const plugin = devApiPlugin(BASE_ENV)
  ;(plugin.configureServer as unknown as (s: unknown) => void)({
    middlewares: { use: (p: string, h: Middleware) => handlers.set(p, h) },
  })
  const h = handlers.get(PATH)
  if (!h) throw new Error('change-tier handler not registered')
  return h
}

async function sessionCookie(email: string): Promise<string> {
  const token = await signSessionToken({ email, roles: [] }, BASE_ENV)
  return `${SESSION_COOKIE_NAME}=${token}`
}

function makeReq(body: unknown, cookie?: string): IncomingMessage {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = 'POST'
  stream.url = PATH
  stream.headers = {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
  }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

function makeRes() {
  let body = ''
  let statusCode = 200
  return {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    headersSent: false,
    setHeader() {},
    getHeader() {
      return undefined
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === 'string' ? chunk : chunk.toString()
    },
    __json: () => JSON.parse(body) as Record<string, unknown>,
  }
}

async function post(body: unknown, cookie?: string) {
  const handler = getHandler()
  const req = makeReq(body, cookie)
  const res = makeRes()
  await new Promise<void>((resolve, reject) => {
    const orig = res.end.bind(res)
    res.end = ((chunk?: string | Buffer) => {
      orig(chunk)
      resolve()
    }) as typeof res.end
    try {
      handler(req, res as unknown as ServerResponse, (err) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : undefined,
      )
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
  return res
}

// A live subscription for `member@example.com` on the given tier/amount.
function withSub(opts: {
  tier: 'ark-plus' | 'bundle'
  amountCents: number
  scheduleId?: string
}) {
  existingCustomers = [{ id: 'cus_1', email: 'member@example.com' }]
  productEntitlements = {
    prod_ark_plus: 'ark_plus',
    prod_bundle: 'ark_plus,circle',
  }
  currentSub = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    currency: 'usd',
    schedule: opts.scheduleId ?? null,
    metadata: {},
    items: {
      data: [
        {
          id: 'si_1',
          price: {
            unit_amount: opts.amountCents,
            product: `prod_${opts.tier === 'ark-plus' ? 'ark_plus' : 'bundle'}`,
            recurring: { interval: 'month' },
          },
          current_period_end: NOW_SEC + 1000,
        },
      ],
    },
  }
}

beforeEach(() => {
  stripeCalls.length = 0
  existingCustomers = []
  currentSub = null
  schedulePhases = []
  productEntitlements = {}
})

describe('POST /api/stripe/change-tier', () => {
  test('401 without a session cookie', async () => {
    const res = await post({ tier: 'ark-plus', plan: 'monthly' })
    expect(res.statusCode).toBe(401)
  })

  test('404 when the member has no live subscription', async () => {
    const res = await post({ tier: 'ark-plus', plan: 'monthly' }, await sessionCookie('member@example.com'))
    expect(res.statusCode).toBe(404)
  })

  test('period-end downgrade to an above-floor PWYC amount bills that amount (not the floor)', async () => {
    // Bundle → Ark+ loses the circle axis, so this lands at period end via a
    // schedule. The chosen $15 is above the $8 Ark+ floor and MUST be billed.
    withSub({ tier: 'bundle', amountCents: 2000 })
    schedulePhases = [
      { start_date: NOW_SEC - 100, end_date: NOW_SEC + 1000, items: [{ price: 'price_bundle_monthly', quantity: 1 }] },
    ]
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 1500 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('period_end')

    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    expect(upd).toBeDefined()
    const phases = (upd!.args[1] as { phases: Array<{ items: Array<Record<string, unknown>> }> }).phases
    // Phase 1 is the destination — an inline price for exactly $15, NOT the floor
    // catalog price id.
    const destItem = phases[1].items[0] as {
      price?: string
      price_data?: { unit_amount?: number }
    }
    expect(destItem.price).toBeUndefined()
    expect(destItem.price_data?.unit_amount).toBe(1500)
  })

  test('period-end change over an existing 2-phase schedule preserves the ACTIVE phase as phase 0', async () => {
    // A pending change already exists → the schedule has [active, future]. The
    // rebuild must keep the active (current-period) phase, not the future one.
    withSub({ tier: 'bundle', amountCents: 2000, scheduleId: 'sched_existing' })
    schedulePhases = [
      { start_date: NOW_SEC - 100, end_date: NOW_SEC + 1000, items: [{ price: 'price_bundle_monthly', quantity: 1 }] },
      { start_date: NOW_SEC + 1000, end_date: NOW_SEC + 2000, items: [{ price: 'price_ark_plus_monthly', quantity: 1 }] },
    ]
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)

    // No new schedule is created — the existing one is reused.
    expect(stripeCalls.some((c) => c.method === 'subscriptionSchedules.create')).toBe(false)
    const upd = stripeCalls.find((c) => c.method === 'subscriptionSchedules.update')
    const phases = (upd!.args[1] as { phases: Array<{ start_date: number }> }).phases
    // Phase 0 is the active period (start in the past), NOT the future phase.
    expect(phases[0].start_date).toBe(NOW_SEC - 100)
  })

  test('immediate upgrade (gains an axis) updates the sub in place, no schedule', async () => {
    // Ark+ → Bundle gains circle → immediate, prorated.
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'bundle', plan: 'monthly' },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.__json().timing).toBe('immediate')
    expect(stripeCalls.some((c) => c.method === 'subscriptions.update')).toBe(true)
    expect(stripeCalls.some((c) => c.method === 'subscriptionSchedules.update')).toBe(false)
  })

  test('below-floor custom amount is rejected', async () => {
    withSub({ tier: 'ark-plus', amountCents: 800 })
    const res = await post(
      { tier: 'ark-plus', plan: 'monthly', custom_amount_cents: 100 },
      await sessionCookie('member@example.com'),
    )
    expect(res.statusCode).toBe(400)
  })
})
