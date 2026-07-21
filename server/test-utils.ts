import { afterAll, beforeEach } from 'bun:test'
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose'
import {
  AUTH0_AUDIENCE,
  AUTH0_EMAIL_CLAIM,
  AUTH0_ROLES_CLAIM,
} from '../shared/auth0-claims'

/**
 * Silences console.error/warn for the calling test file. Several suites
 * deliberately drive error and fallback paths (upstream 500s, missing config)
 * whose handlers log via console.error/warn — expected behavior, but it dumps
 * stack traces into an otherwise-green run. Call once at module scope; it
 * registers its own beforeEach/afterAll so the originals are restored after the
 * file finishes (other test files keep their console intact).
 */
export function silenceExpectedConsole() {
  const originalError = console.error
  const originalWarn = console.warn
  beforeEach(() => {
    console.error = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.error = originalError
    console.warn = originalWarn
  })
}

// jose's createRemoteJWKSet caches keys process-wide keyed on the JWKS URL.
// Every test file that signs Auth0 tokens hits the same URL, so if two files
// each generated their own keypair the first to run would seed the cache and
// the second file's tokens would fail to verify. One shared keypair avoids it.
export const AUTH0_TEST_DOMAIN = 'https://auth.ark-plus.xyz'
export const AUTH0_TEST_JWKS_URL = `${AUTH0_TEST_DOMAIN}/.well-known/jwks.json`
export const AUTH0_TEST_KID = 'shared-test-key'

let cached: { privateKey: CryptoKey; publicJwk: JWK } | null = null

export async function getAuth0TestKeys(): Promise<{
  privateKey: CryptoKey
  publicJwk: JWK
}> {
  if (cached) return cached
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  })
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    use: 'sig',
    alg: 'RS256',
    kid: AUTH0_TEST_KID,
  }
  cached = { privateKey, publicJwk }
  return cached
}

// Auth0 no longer carries a tier claim (task 5); entitlement is a Neon read
// keyed on the token `sub`. Tests set `sub` to control which membership row the
// resolver reads. `roles` drives the admin gate.
export async function signAuth0TestToken(claims: {
  email: string
  sub?: string
  roles?: string[]
}): Promise<string> {
  const { privateKey } = await getAuth0TestKeys()
  const payload: Record<string, unknown> = {
    [AUTH0_EMAIL_CLAIM]: claims.email,
  }
  if (claims.roles) payload[AUTH0_ROLES_CLAIM] = claims.roles
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: AUTH0_TEST_KID })
    .setIssuer(`${AUTH0_TEST_DOMAIN}/`)
    .setAudience(AUTH0_AUDIENCE)
    .setSubject(claims.sub ?? `auth0|${claims.email}`)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}
