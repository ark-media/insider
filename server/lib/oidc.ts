// OpenID Connect configuration for the server-side login flow (the BFF).
//
// The browser never holds an Auth0 token: server/routes/auth.ts runs the
// Authorization Code + PKCE flow here and mints its own httpOnly session
// cookie (see lib/session.ts). This module just owns the discovered Auth0
// metadata + confidential-client credentials.
//
// Confidential client: this is a *Regular Web Application* in Auth0 (has a
// client secret), distinct from the old public SPA client. It needs:
//   AUTH0_WEB_CLIENT_ID, AUTH0_WEB_CLIENT_SECRET

import * as client from 'openid-client'
import { AUTH0_DOMAIN } from '../auth0.js'

type Env = Record<string, string>

export class OidcNotConfiguredError extends Error {
  constructor() {
    super('AUTH0_WEB_CLIENT_ID / AUTH0_WEB_CLIENT_SECRET not configured')
    this.name = 'OidcNotConfiguredError'
  }
}

// Discovery is a network round-trip, so cache the resolved Configuration for
// the lifetime of the process. Effective in long-running dev/prod; re-runs on
// each serverless cold start (acceptable — it's one well-known-endpoint fetch).
let cached: Promise<client.Configuration> | null = null

export function getOidcConfig(env: Env): Promise<client.Configuration> {
  const clientId = env.AUTH0_WEB_CLIENT_ID
  const clientSecret = env.AUTH0_WEB_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return Promise.reject(new OidcNotConfiguredError())
  }
  if (!cached) {
    cached = client.discovery(new URL(AUTH0_DOMAIN), clientId, clientSecret)
  }
  return cached
}
