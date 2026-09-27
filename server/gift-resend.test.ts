// Expired gift links: /api/gift/claim tells an expired link from a bogus one,
// and /api/gift/resend-claim swaps an expired link for a fresh one sent to the
// address the old link was made for.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { SignJWT } from 'jose'
import {
  createDevApiHarness,
  neonMockModule,
  silenceExpectedConsole,
  type SqlCall,
} from './test-utils'

const sqlCalls: SqlCall[] = []
let giftRow: Record<string, unknown> | null = null
let rateLimited = false
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql) => {
    if (sql.includes('from gift where redemption_token')) return giftRow ? [giftRow] : []
    if (sql.includes('rate_limit_buckets') && sql.includes('insert')) {
      return rateLimited ? [{ tokens: 0, allowed: false }] : [{ tokens: 2, allowed: true }]
    }
    return []
  }),
)

import { devApiPlugin } from './dev-api'
import { signGiftClaimToken, verifyExpiredGiftClaimToken } from './lib/session'

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
const ENV = {
  SESSION_SECRET: SECRET,
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-gift-resend',
  RESEND_API_KEY: 're_test',
}
const harness = createDevApiHarness(devApiPlugin(ENV))

// A gift link signed exactly as signGiftClaimToken does, but already past its
// expiry (or with another audience, to prove that isn't accepted).
async function oldLink(
  claims: Record<string, unknown>,
  opts: { audience?: string } = {},
): Promise<string> {
  const past = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('ark-insider')
    .setAudience(opts.audience ?? 'gift-claim')
    .setIssuedAt(past - 14 * 24 * 60 * 60)
    .setExpirationTime(past)
    .sign(new TextEncoder().encode(SECRET))
}

const originalFetch = globalThis.fetch
const sent: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = []
let resendOk = true
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.startsWith('https://api.resend.com')) {
    sent.push({
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    return new Response('{"id":"e_1"}', { status: resendOk ? 200 : 500 })
  }
  return new Response('{}', { status: 200 })
}) as typeof fetch

silenceExpectedConsole()
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  sqlCalls.length = 0
  sent.length = 0
  giftRow = { redemption_token: 'gt_1', tier: 'circle', plan: '6mo', status: 'pending' }
  rateLimited = false
  resendOk = true
})

describe('verifyExpiredGiftClaimToken', () => {
  test('an expired link of ours → its claim', async () => {
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com', name: 'Rae' })
    expect(await verifyExpiredGiftClaimToken(mt, ENV)).toEqual({
      giftToken: 'gt_1',
      email: 'r@x.com',
      name: 'Rae',
      tier: undefined,
    })
  })

  test('a live link → null (use it instead)', async () => {
    const mt = await signGiftClaimToken({ giftToken: 'gt_1', email: 'r@x.com' }, ENV)
    expect(await verifyExpiredGiftClaimToken(mt, ENV)).toBeNull()
  })

  test('an expired token of another audience → null', async () => {
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com' }, { audience: 'email-login' })
    expect(await verifyExpiredGiftClaimToken(mt, ENV)).toBeNull()
  })

  test('garbage, or another secret → null', async () => {
    expect(await verifyExpiredGiftClaimToken('not-a-token', ENV)).toBeNull()
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com' })
    expect(
      await verifyExpiredGiftClaimToken(mt, { SESSION_SECRET: 'another-secret-0123456789abcdef0123' }),
    ).toBeNull()
  })
})

describe('POST /api/gift/claim — expired vs invalid', () => {
  test('an expired link of ours → expired_link', async () => {
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com' })
    const res = await harness.call('/api/gift/claim', { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toBe('expired_link')
  })

  test('a token that was never ours → invalid_gift', async () => {
    const res = await harness.call('/api/gift/claim', { method: 'POST', body: { mt: 'nope' } })
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toBe('invalid_gift')
  })
})

describe('POST /api/gift/resend-claim', () => {
  const PATH = '/api/gift/resend-claim'

  test('mails a fresh, working link to the address on the old one', async () => {
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com', name: 'Rae' })
    const res = await harness.call(PATH, { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(200)
    expect(res.__json()).toEqual({ sent: true })

    expect(sent).toHaveLength(1)
    expect(sent[0].body.to).toBe('r@x.com')
    // Names the gift from the row, not the link: a 6-month Fold gift.
    expect(String(sent[0].body.subject)).toContain('the Fold')
    expect(String(sent[0].body.html)).toContain('6 months')

    const fresh = decodeURIComponent(
      /\/redeem\?mt=([^"&]+)/.exec(String(sent[0].body.html))?.[1] ?? '',
    )
    const { verifyGiftClaimToken } = await import('./lib/session')
    expect(await verifyGiftClaimToken(fresh, ENV)).toMatchObject({
      giftToken: 'gt_1',
      email: 'r@x.com',
    })

    // The redemption token is a credential: never in the idempotency key.
    const key = sent[0].headers['Idempotency-Key']
    expect(key).toMatch(/^gift_resend_[0-9a-f]{32}_\d{4}-\d{2}-\d{2}$/)
    expect(key).not.toContain('gt_1')
  })

  test('a live link is not resendable', async () => {
    const mt = await signGiftClaimToken({ giftToken: 'gt_1', email: 'r@x.com' }, ENV)
    const res = await harness.call(PATH, { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(400)
    expect(sent).toHaveLength(0)
  })

  test('a claimed or voided gift → 409, no email', async () => {
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com' })
    giftRow = { ...giftRow, status: 'redeemed' }
    let res = await harness.call(PATH, { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { error: string }).error).toBe('already_redeemed')
    giftRow = { ...giftRow, status: 'void' }
    res = await harness.call(PATH, { method: 'POST', body: { mt } })
    expect((res.__json() as { error: string }).error).toBe('gift_voided')
    expect(sent).toHaveLength(0)
  })

  test('an unknown gift → 404', async () => {
    giftRow = null
    const mt = await oldLink({ giftToken: 'gt_gone', email: 'r@x.com' })
    const res = await harness.call(PATH, { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(404)
  })

  test('rate-limited → 429 with retry-after, no email', async () => {
    rateLimited = true
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com' })
    const res = await harness.call(PATH, { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(429)
    expect(res.__headers()['retry-after']).toBeDefined()
    expect(sent).toHaveLength(0)
  })

  test('a failed send → 502', async () => {
    resendOk = false
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com' })
    const res = await harness.call(PATH, { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(502)
  })

  test('a cross-origin request → 403', async () => {
    const mt = await oldLink({ giftToken: 'gt_1', email: 'r@x.com' })
    const res = await harness.call(PATH, {
      method: 'POST',
      body: { mt },
      headers: { origin: 'https://evil.example' },
    })
    expect(res.statusCode).toBe(403)
  })
})
