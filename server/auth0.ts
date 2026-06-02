// ---------------------------------------------------------------------------
// Auth0 client factories shared by the webhook/entitlement paths and the
// admin script. We use the official `auth0` SDK (node-auth0 v5):
//   - ManagementClient for the Management API (users, roles, jobs, tickets).
//     It manages the M2M client-credentials token itself, so there's no
//     hand-rolled token fetch/cache here anymore.
//   - AuthenticationClient for the one Authentication-API call we make
//     (dbconnections/change_password), which lives on the custom login domain.
//
// Domain split (load-bearing): the public login domain is custom
// (auth.ark-plus.xyz) and is used for JWKS, the ID-token issuer, and the
// change_password email. The Management API lives on the native tenant domain
// (e.g. foo.us.auth0.com), resolved from env.AUTH0_TENANT_DOMAIN. Keeping two
// factories ensures the two domains can't be accidentally collapsed.
// ---------------------------------------------------------------------------

import { AuthenticationClient, ManagementClient } from 'auth0'

export const AUTH0_DOMAIN = 'https://auth.ark-plus.xyz'

// Public (PKCE) client on the login domain — the one whose branded
// change_password email template is configured. Used only by the
// AuthenticationClient below. Overridable per environment via
// AUTH0_LOGIN_CLIENT_ID (e.g. a separate staging tenant); defaults to prod.
const DEFAULT_AUTH0_LOGIN_CLIENT_ID = '1T1u9VRHbSWxOwy8OX5PVYw9BdPNtAvp'

type Env = Record<string, string>

// The SDK wants a bare host; our env/constants carry full https:// URLs.
function hostOf(domainOrUrl: string): string {
  return new URL(domainOrUrl).host
}

// Module-level cache is effective in long-running dev/prod processes and reset
// on each serverless cold start. The SDK caches the M2M token internally, so
// reusing one client instance also reuses its token across calls.
let cachedMgmt: { key: string; client: ManagementClient } | null = null

// Returns a ready Management API client, or null when the M2M credentials
// aren't configured. Callers rely on the null to preserve their
// "skip / no-op / empty" branches (the SDK itself doesn't model missing creds).
export function getManagementClient(env: Env): ManagementClient | null {
  const clientId = env.AUTH0_MANAGEMENT_CLIENT_ID
  const clientSecret = env.AUTH0_MANAGEMENT_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  const domain = hostOf(env.AUTH0_TENANT_DOMAIN || AUTH0_DOMAIN)
  const key = `${domain}:${clientId}`
  if (cachedMgmt?.key === key) return cachedMgmt.client

  const client = new ManagementClient({ domain, clientId, clientSecret })
  cachedMgmt = { key, client }
  return client
}

let cachedAuth: { key: string; client: AuthenticationClient } | null = null

// Authentication API client pointed at the custom login domain. Used only for
// the change_password email (see lib/auth0-user.ts). The client_id is the
// public login client (env-overridable); no secret is needed for that endpoint.
export function getAuthenticationClient(env: Env): AuthenticationClient {
  const domain = hostOf(AUTH0_DOMAIN)
  const clientId = env.AUTH0_LOGIN_CLIENT_ID || DEFAULT_AUTH0_LOGIN_CLIENT_ID
  const key = `${domain}:${clientId}`
  if (cachedAuth?.key === key) return cachedAuth.client

  const client = new AuthenticationClient({ domain, clientId })
  cachedAuth = { key, client }
  return client
}
