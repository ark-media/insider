// ---------------------------------------------------------------------------
// Auth0 helpers shared by dev-api.ts and entitlement.ts. Pulled out of
// dev-api.ts to break the circular import between webhook handling and
// entitlement sync — both consume the management token helper.
//
// Note on the AUTH0_DOMAIN constant: the public login domain (used for JWKS
// and ID-token issuer) is custom (auth.ark-plus.xyz). The Management API
// however lives on the native tenant domain (e.g. foo.us.auth0.com) and the
// caller resolves that via env.AUTH0_TENANT_DOMAIN.
// ---------------------------------------------------------------------------

export const AUTH0_DOMAIN = 'https://auth.ark-plus.xyz'

type Env = Record<string, string>
type Auth0MgmtToken = { access_token: string; expires_at: number }

// Module-level cache is effective in long-running dev/prod processes but
// resets on each serverless cold start — tokens are re-fetched per
// invocation there.
let cachedMgmtToken: Auth0MgmtToken | null = null

export async function getAuth0ManagementToken(env: Env): Promise<string | null> {
  const clientId = env.AUTH0_MANAGEMENT_CLIENT_ID
  const clientSecret = env.AUTH0_MANAGEMENT_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  if (cachedMgmtToken && cachedMgmtToken.expires_at > Date.now() + 60_000) {
    return cachedMgmtToken.access_token
  }

  const tenantDomain = env.AUTH0_TENANT_DOMAIN || AUTH0_DOMAIN

  const res = await fetch(`${tenantDomain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `${tenantDomain}/api/v2/`,
    }),
  })
  if (!res.ok) {
    console.error('[auth0] mgmt token failed:', res.status, await res.text())
    return null
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedMgmtToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }
  return data.access_token
}

export function auth0MgmtBase(env: Env): string {
  return `${env.AUTH0_TENANT_DOMAIN || AUTH0_DOMAIN}/api/v2`
}
