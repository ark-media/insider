// The admin role is snapshotted into a 7-day stateless session cookie, so
// without a live re-check, removing someone's admin role in Auth0 would have no
// effect until that cookie expired — and signing them out wouldn't help either,
// since logout only clears the cookie while the JWT stays valid.
//
// These tests pin the three outcomes that matter: a still-admin passes, a
// revoked admin is denied, and an unavailable Management API falls back to the
// cookie rather than locking the whole back office out.

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { IncomingMessage } from 'node:http'

// Role NAMES the stubbed Management API will report. `null` makes the call
// throw, so the "lookup failed" branch is exercised distinctly from
// "no credentials configured".
let roleNames: string[] | null = ['admin']

mock.module('auth0', () => ({
  ManagementClient: class {
    users = {
      roles: {
        // Mirrors the real shape: a page whose `data` is Role objects.
        list: async () => {
          if (roleNames === null) throw new Error('auth0 unavailable')
          return { data: roleNames.map((name) => ({ name })) }
        },
      },
    }
  },
  AuthenticationClient: class {},
  __esModule: true,
}))

const { requireAdmin, signSessionToken, __resetAdminRoleCacheForTests } = await import('./session')
const { SESSION_COOKIE_NAME } = await import('./cookies')
const { silenceExpectedConsole } = await import('../test-utils')

// Half these cases deliberately drive the revoke / unavailable branches, which
// log by design.
silenceExpectedConsole()

const SUB = 'auth0|admin-user'
// Credentials present → getManagementClient returns a (stubbed) client, so the
// live path actually runs.
const ENV_WITH_MGMT = {
  SESSION_SECRET: 'session-secret-32-chars-long-aaaaaa',
  AUTH0_MANAGEMENT_CLIENT_ID: 'mgmt-client',
  AUTH0_MANAGEMENT_CLIENT_SECRET: 'mgmt-secret',
}
const ENV_NO_MGMT = { SESSION_SECRET: 'session-secret-32-chars-long-aaaaaa' }

async function adminReq(env: Record<string, string>): Promise<IncomingMessage> {
  const token = await signSessionToken(
    { email: 'admin@ark.com', roles: ['admin'], sub: SUB },
    env,
  )
  return {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  } as unknown as IncomingMessage
}

beforeEach(() => {
  __resetAdminRoleCacheForTests()
  roleNames = ['admin']
})

describe('requireAdmin — live role revocation', () => {
  test('passes when Auth0 still reports the admin role', async () => {
    const admin = await requireAdmin(await adminReq(ENV_WITH_MGMT), ENV_WITH_MGMT)
    expect(admin?.email).toBe('admin@ark.com')
  })

  test('denies a valid cookie once the role is revoked in Auth0', async () => {
    // The cookie is untouched and still says roles:['admin'] — only Auth0 changed.
    roleNames = ['member']
    expect(await requireAdmin(await adminReq(ENV_WITH_MGMT), ENV_WITH_MGMT)).toBeNull()
  })

  test('denies when Auth0 reports no roles at all', async () => {
    roleNames = []
    expect(await requireAdmin(await adminReq(ENV_WITH_MGMT), ENV_WITH_MGMT)).toBeNull()
  })

  test('falls back to the cookie when Management credentials are absent', async () => {
    // A missing env var must not become a total back-office lockout; exposure is
    // bounded by the cookie TTL, which is where it already was.
    const admin = await requireAdmin(await adminReq(ENV_NO_MGMT), ENV_NO_MGMT)
    expect(admin?.email).toBe('admin@ark.com')
  })

  test('falls back to the cookie when the lookup throws', async () => {
    roleNames = null
    const admin = await requireAdmin(await adminReq(ENV_WITH_MGMT), ENV_WITH_MGMT)
    expect(admin?.email).toBe('admin@ark.com')
  })

  test('caches a positive answer so the back office does not round-trip per click', async () => {
    const req = await adminReq(ENV_WITH_MGMT)
    expect(await requireAdmin(req, ENV_WITH_MGMT)).not.toBeNull()
    // Revoke at the source; the cached "yes" is still within its TTL.
    roleNames = []
    expect(await requireAdmin(req, ENV_WITH_MGMT)).not.toBeNull()
    // Clearing the cache surfaces the revocation immediately.
    __resetAdminRoleCacheForTests()
    expect(await requireAdmin(req, ENV_WITH_MGMT)).toBeNull()
  })
})
