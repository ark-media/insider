// Unit tests for the OIDC config cache. The key guarantee: a failed discovery
// must not be cached (else one transient outage wedges every later login).

import { describe, test, expect, mock } from 'bun:test'

let calls = 0
let mode: 'reject' | 'resolve' = 'reject'

mock.module('openid-client', () => ({
  discovery: async () => {
    calls++
    if (mode === 'reject') throw new Error('discovery failed')
    return { fake: 'config' }
  },
}))

// Imported after the mock so it picks up the fake discovery().
import { getOidcConfig, OidcNotConfiguredError } from './oidc'

const ENV = { AUTH0_WEB_CLIENT_ID: 'id', AUTH0_WEB_CLIENT_SECRET: 'secret' }

describe('getOidcConfig', () => {
  test('rejects without discovery when the client is not configured', async () => {
    await expect(getOidcConfig({})).rejects.toBeInstanceOf(OidcNotConfiguredError)
    expect(calls).toBe(0)
  })

  test('does not cache a failed discovery (retries next call)', async () => {
    mode = 'reject'
    await expect(getOidcConfig(ENV)).rejects.toThrow('discovery failed')
    await expect(getOidcConfig(ENV)).rejects.toThrow('discovery failed')
    expect(calls).toBe(2) // would be 1 if the rejection were cached
  })

  test('caches a successful discovery', async () => {
    mode = 'resolve'
    const a = await getOidcConfig(ENV)
    const b = await getOidcConfig(ENV)
    expect(a).toBe(b)
    expect(calls).toBe(3) // one more discovery call, second served from cache
  })
})
