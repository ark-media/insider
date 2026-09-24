// requireBillingEmail: who may move money. A real sign-in always; an emailed
// link's session never — except the welcome-offer link, while fresh, on the
// one route that names it.

import { describe, test, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requireBillingEmail } from './guards'
import { signSessionToken, type SessionProfile } from './session'
import { SESSION_COOKIE_NAME } from './cookies'

const ENV = { SESSION_SECRET: 'session-secret-32-chars-long-aaaaaa' }
const NOW = Math.floor(Date.now() / 1000)

async function reqWith(profile: SessionProfile): Promise<IncomingMessage> {
  const token = await signSessionToken(profile, ENV)
  return { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } } as unknown as IncomingMessage
}

function makeRes() {
  const r = { statusCode: 200, body: '' }
  const res = {
    get statusCode() {
      return r.statusCode
    },
    set statusCode(v: number) {
      r.statusCode = v
    },
    setHeader() {},
    end(b?: string) {
      r.body = b ?? ''
    },
  }
  return { res: res as unknown as ServerResponse, r }
}

const link = { email: 'm@x.com', roles: [], via: 'email_link' as const }

describe('requireBillingEmail', () => {
  test('a signed-in session passes', async () => {
    const { res } = makeRes()
    expect(await requireBillingEmail(await reqWith({ email: 'm@x.com', roles: [] }), res, ENV)).toBe(
      'm@x.com',
    )
  })

  test('a plain emailed-link session is refused, even where a fresh link is accepted', async () => {
    const { res, r } = makeRes()
    const req = await reqWith({ ...link, linkIssuedAt: NOW - 60 })
    expect(await requireBillingEmail(req, res, ENV, { acceptFreshLink: 'welcome_offer' })).toBeNull()
    expect(r.statusCode).toBe(401)
    expect(r.body).toContain('reauth_required')
  })

  test('a fresh welcome-offer link session passes only where the route accepts it', async () => {
    const offer = { ...link, linkPurpose: 'welcome_offer' as const, linkIssuedAt: NOW - 3600 }
    expect(
      await requireBillingEmail(await reqWith(offer), makeRes().res, ENV, {
        acceptFreshLink: 'welcome_offer',
      }),
    ).toBe('m@x.com')
    // Every other billing route (update-card, change-plan, …) still refuses it.
    expect(await requireBillingEmail(await reqWith(offer), makeRes().res, ENV)).toBeNull()
  })

  test('a welcome-offer link session older than 48 hours is refused', async () => {
    const stale = { ...link, linkPurpose: 'welcome_offer' as const, linkIssuedAt: NOW - 49 * 3600 }
    const { res, r } = makeRes()
    expect(
      await requireBillingEmail(await reqWith(stale), res, ENV, { acceptFreshLink: 'welcome_offer' }),
    ).toBeNull()
    expect(r.body).toContain('reauth_required')
  })
})
