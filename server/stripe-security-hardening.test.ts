// Security-review hardening (2026-10) that has no better-fitting suite:
//
//   - the card-setup limiter is SHARED (one Neon bucket per member), not an
//     in-memory bucket each function instance gets its own copy of;
//   - gift redemption tokens derive from GIFT_TOKEN_SECRET first, so rotating
//     SESSION_SECRET (the sign-everyone-out lever) can't orphan refund handling
//     for gifts already sold.

import crypto from 'node:crypto'
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  createDevApiHarness,
  makeFakeReq,
  makeFakeRes,
  neonMockModule,
  runMiddleware,
  silenceExpectedConsole,
  type SqlCall,
} from './test-utils'

// --- neon: the shared rate-limit table ---------------------------------------
const sqlCalls: SqlCall[] = []
// What the bucket upsert answers: allowed, or spent.
let bucketAllows = true
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql) => {
    if (sql.includes('insert into rate_limit_buckets')) {
      return [{ tokens: bucketAllows ? 9 : 0, allowed: bucketAllows }]
    }
    return []
  }),
)

// --- stripe ------------------------------------------------------------------
const stripeCalls: string[] = []
class FakeStripe {
  constructor(_key: string) {}
  customers = {
    list: async (args: { email: string }) => ({
      data: args.email === 'member@example.com' ? [{ id: 'cus_me', email: args.email }] : [],
    }),
  }
  subscriptions = {
    list: async (args: { customer: string }) => ({
      data: [
        { id: 'sub_me', customer: args.customer, status: 'active', schedule: null, items: { data: [] } },
      ],
    }),
  }
  setupIntents = {
    create: async () => {
      stripeCalls.push('setupIntents.create')
      return { id: 'seti_new', client_secret: 'seti_new_secret' }
    },
  }
  webhooks = {
    constructEvent: () => {
      throw new Error('not used in this file')
    },
  }
}
mock.module('stripe', () => ({ default: FakeStripe, __esModule: true }))

import { devApiPlugin } from './dev-api'
import { signSessionToken } from './lib/session'
import { SESSION_COOKIE_NAME } from './lib/cookies'
import { giftTokenForPaymentIntent } from './routes/stripe/webhook'

const ENV = {
  SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-security-hardening',
}
const SETUP_PATH = '/api/stripe/card-setup-intent'

silenceExpectedConsole()
beforeEach(() => {
  sqlCalls.length = 0
  stripeCalls.length = 0
  bucketAllows = true
})

async function openCardForm() {
  // A fresh plugin instance each call — a different "function instance".
  const handler = createDevApiHarness(devApiPlugin(ENV)).getHandler(SETUP_PATH)
  const token = await signSessionToken({ email: 'member@example.com', roles: [] }, ENV)
  const res = makeFakeRes()
  await runMiddleware(
    handler,
    makeFakeReq({
      method: 'POST',
      url: SETUP_PATH,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }),
    res,
  )
  return res
}

describe('card-setup-intent limiter is shared across instances', () => {
  test('takes its token from the Neon bucket keyed on the member', async () => {
    const res = await openCardForm()
    expect(res.statusCode).toBe(200)
    const take = sqlCalls.find((c) => c.sql.includes('insert into rate_limit_buckets'))
    expect(take).toBeDefined()
    const expected = crypto
      .createHash('sha256')
      .update('stripe-card-setup-email|member@example.com')
      .digest('hex')
    expect(take!.values[0]).toBe(expected)
  })

  test('a spent shared bucket refuses even a brand-new instance', async () => {
    bucketAllows = false
    const res = await openCardForm()
    expect(res.statusCode).toBe(429)
    expect(res.__headers()['retry-after']).toBeTruthy()
    expect(stripeCalls).toEqual([])
  })
})

describe('giftTokenForPaymentIntent key', () => {
  const GIFT = 'gift-secret-0123456789abcdef0123456789abcdef'
  const SESSION_A = 'session-a-0123456789abcdef0123456789abcdef'
  const SESSION_B = 'session-b-0123456789abcdef0123456789abcdef'

  test('GIFT_TOKEN_SECRET wins, so rotating SESSION_SECRET keeps every gift findable', () => {
    const before = giftTokenForPaymentIntent('pi_1', { GIFT_TOKEN_SECRET: GIFT, SESSION_SECRET: SESSION_A })
    const after = giftTokenForPaymentIntent('pi_1', { GIFT_TOKEN_SECRET: GIFT, SESSION_SECRET: SESSION_B })
    expect(after).toBe(before)
  })

  test('falls back to SESSION_SECRET only when GIFT_TOKEN_SECRET is unset', () => {
    expect(giftTokenForPaymentIntent('pi_1', { SESSION_SECRET: SESSION_A })).toBe(
      giftTokenForPaymentIntent('pi_1', { GIFT_TOKEN_SECRET: SESSION_A }),
    )
  })

  test('keeps the 32-byte floor', () => {
    expect(() => giftTokenForPaymentIntent('pi_1', { GIFT_TOKEN_SECRET: 'short' })).toThrow()
    expect(() => giftTokenForPaymentIntent('pi_1', {})).toThrow()
  })
})
