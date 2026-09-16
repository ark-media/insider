// ---------------------------------------------------------------------------
// Auth0 client factories shared by the webhook/entitlement paths and the
// admin script. We use the official `auth0` SDK (node-auth0 v5):
//   - ManagementClient for the Management API (users, roles, jobs, tickets).
//     It manages the M2M client-credentials token itself, so there's no
//     hand-rolled token fetch/cache here anymore.
//
// There was also an AuthenticationClient here, for the one Authentication-API
// call we made: dbconnections/change_password. Password sign-in was removed
// from the login page on 2026-09-16, so nothing sends that email any more.
//
// Domain split (still load-bearing): the public login domain is custom
// (auth.ark-plus.xyz) and is used for JWKS and the ID-token issuer. The
// Management API lives on the native tenant domain (e.g. foo.us.auth0.com),
// resolved from env.AUTH0_TENANT_DOMAIN — the two must not be collapsed.
// ---------------------------------------------------------------------------

import { ManagementClient } from 'auth0'

export const AUTH0_DOMAIN = 'https://auth.ark-plus.xyz'

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

