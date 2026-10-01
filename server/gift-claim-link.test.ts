// Gift claim links never expire: a recipient can activate a gift on any future
// date. New links carry no `exp`; links minted while they lasted 14 days are
// honoured past it. A link is still single-use — once the gift is spent,
// /api/gift/claim refuses it without minting a session.

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { SignJWT } from 'jose'
import {
  createDevApiHarness,
  neonMockModule,
  silenceExpectedConsole,
  type SqlCall,
} from './test-utils'

const sqlCalls: SqlCall[] = []
let giftRow: Record<string, unknown> | null = null
mock.module('@neondatabase/serverless', () =>
  neonMockModule(sqlCalls, (sql) => {
    if (sql.includes('from gift where redemption_token')) return giftRow ? [giftRow] : []
    return []
  }),
)

import { devApiPlugin } from './dev-api'
import { signGiftClaimToken, verifyGiftClaimToken } from './lib/session'

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
const ENV = {
  SESSION_SECRET: SECRET,
  APP_BASE_URL: 'http://localhost:5173',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgres://stub-gift-claim-link',
}
const harness = createDevApiHarness(devApiPlugin(ENV))

const DAY_SEC = 24 * 60 * 60

// A link signed the way signGiftClaimToken used to: with a 14-day `exp`, here
// long past (or with another audience/issuer, to prove those don't pass).
async function legacyLink(
  claims: Record<string, unknown>,
  opts: { audience?: string; issuer?: string; secret?: string } = {},
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 400 * DAY_SEC
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.issuer ?? 'ark-insider')
    .setAudience(opts.audience ?? 'gift-claim')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 14 * DAY_SEC)
    .sign(new TextEncoder().encode(opts.secret ?? SECRET))
}

silenceExpectedConsole()
beforeEach(() => {
  sqlCalls.length = 0
  giftRow = { redemption_token: 'gt_1', tier: 'circle', plan: '6mo', status: 'pending' }
})
afterEach(() => {
  setSystemTime()
})

describe('gift claim link lifetime', () => {
  test('a new link has no exp', async () => {
    const mt = await signGiftClaimToken({ giftToken: 'gt_1', email: 'r@x.com' }, ENV)
    const payload = JSON.parse(Buffer.from(mt.split('.')[1]!, 'base64url').toString('utf8'))
    expect(payload.exp).toBeUndefined()
  })

  test('still valid years after it was sent', async () => {
    const T0 = Date.parse('2026-10-01T12:00:00.000Z')
    setSystemTime(new Date(T0))
    const mt = await signGiftClaimToken({ giftToken: 'gt_1', email: 'r@x.com', name: 'Rae' }, ENV)
    setSystemTime(new Date(T0 + 5 * 365 * DAY_SEC * 1000))
    expect(await verifyGiftClaimToken(mt, ENV)).toEqual({
      giftToken: 'gt_1',
      email: 'r@x.com',
      name: 'Rae',
    })
  })

  test('a legacy link past its old 14-day exp is still honoured', async () => {
    const mt = await legacyLink({ giftToken: 'gt_1', email: 'r@x.com' })
    expect(await verifyGiftClaimToken(mt, ENV)).toMatchObject({ giftToken: 'gt_1', email: 'r@x.com' })
  })

  test('an expired token of another audience or issuer → null', async () => {
    const claims = { giftToken: 'gt_1', email: 'r@x.com' }
    expect(await verifyGiftClaimToken(await legacyLink(claims, { audience: 'email-login' }), ENV)).toBeNull()
    expect(await verifyGiftClaimToken(await legacyLink(claims, { issuer: 'someone-else' }), ENV)).toBeNull()
  })

  test('garbage, another secret, or missing claims → null', async () => {
    expect(await verifyGiftClaimToken('not-a-token', ENV)).toBeNull()
    const other = await legacyLink(
      { giftToken: 'gt_1', email: 'r@x.com' },
      { secret: 'another-secret-0123456789abcdef0123' },
    )
    expect(await verifyGiftClaimToken(other, ENV)).toBeNull()
    expect(await verifyGiftClaimToken(await legacyLink({ email: 'r@x.com' }), ENV)).toBeNull()
  })
})

describe('POST /api/gift/claim with an old link', () => {
  test('a spent gift → 409 already_redeemed, no session', async () => {
    giftRow = { ...giftRow, status: 'redeemed' }
    const mt = await legacyLink({ giftToken: 'gt_1', email: 'r@x.com' })
    const res = await harness.call('/api/gift/claim', { method: 'POST', body: { mt } })
    expect(res.statusCode).toBe(409)
    expect((res.__json() as { error: string }).error).toBe('already_redeemed')
    expect(String(res.__headers()['set-cookie'] ?? '')).not.toContain('ark_session=')
  })

  test('a token that was never ours → invalid_gift', async () => {
    const res = await harness.call('/api/gift/claim', { method: 'POST', body: { mt: 'nope' } })
    expect(res.statusCode).toBe(400)
    expect((res.__json() as { error: string }).error).toBe('invalid_gift')
  })
})
