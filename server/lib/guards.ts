// Request guards composed from the lower-level checks in session.ts/http.ts.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOrigin, makeJsonRes } from './http.js'
import { requireAdmin, type Auth0Profile } from './session.js'

type Env = Record<string, string>

// Back-office gate for a mutating request: admin role + same-origin (CSRF).
// On failure it writes the 403 and returns null; on success returns the
// profile. GET requests skip the origin check (reads aren't CSRF-sensitive).
export async function requireAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: Env,
  appBaseUrl: string,
): Promise<Auth0Profile | null> {
  const json = makeJsonRes(res)
  const admin = await requireAdmin(req, env)
  if (!admin) {
    json(403, { error: 'forbidden' })
    return null
  }
  if (req.method !== 'GET' && !isSameOrigin(req, appBaseUrl)) {
    json(403, { error: 'bad_origin' })
    return null
  }
  return admin
}
