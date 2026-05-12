// Auth0 user creation after a successful payment. The token + tenant base
// helpers live in ../auth0.ts; this module only does the find-or-create
// dance and triggers the password-reset email new members use to set their
// first password.

import crypto from 'node:crypto'
import { AUTH0_DOMAIN, auth0MgmtBase, getAuth0ManagementToken } from '../auth0.js'

type Env = Record<string, string>

const AUTH0_CLIENT_ID = '1T1u9VRHbSWxOwy8OX5PVYw9BdPNtAvp'

// `created` distinguishes a brand-new account (we just issued the
// password-reset email) from a pre-existing one (no email was sent because
// the user already has a login). `passwordResetSent` reports whether the
// reset email actually went out — false means the account exists but cannot
// be logged into yet, which callers should surface for manual support.
export type Auth0UserResult = {
  userId: string
  created: boolean
  passwordResetSent: boolean
}

export async function findOrCreateAuth0User(
  email: string,
  nameHint: string | undefined,
  env: Env,
): Promise<Auth0UserResult | null> {
  const token = await getAuth0ManagementToken(env)
  if (!token) return null

  const base = auth0MgmtBase(env)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // Return early if Auth0 user already exists.
  const searchRes = await fetch(
    `${base}/users-by-email?email=${encodeURIComponent(email)}`,
    { headers },
  )
  if (searchRes.ok) {
    const existing = (await searchRes.json()) as Array<{ user_id: string }>
    if (existing.length > 0) {
      return { userId: existing[0].user_id, created: false, passwordResetSent: false }
    }
  }

  // Create Auth0 user with a random temporary password — the password-change
  // email below is how they'll actually log in for the first time.
  const spaceIdx = (nameHint ?? '').indexOf(' ')
  const givenName = spaceIdx > -1 ? nameHint!.slice(0, spaceIdx) : (nameHint ?? '')
  const familyName = spaceIdx > -1 ? nameHint!.slice(spaceIdx + 1) : ''
  const tempPassword = `Tmp-${crypto.randomBytes(16).toString('hex')}`

  const createRes = await fetch(`${base}/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      connection: 'Username-Password-Authentication',
      email,
      password: tempPassword,
      given_name: (givenName || email.split('@')[0]).slice(0, 40),
      ...(familyName ? { family_name: familyName.slice(0, 40) } : {}),
      email_verified: false,
    }),
  })
  if (!createRes.ok) {
    console.error('[auth0] create user failed:', createRes.status, await createRes.text())
    return null
  }
  const created = (await createRes.json()) as { user_id: string }

  // The user record exists but has only the random temp password. Without
  // the change_password email going through, they have no way to sign in —
  // surface this so the caller can flag for manual support resend.
  let passwordResetSent = false
  try {
    const resetRes = await fetch(`${AUTH0_DOMAIN}/dbconnections/change_password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: AUTH0_CLIENT_ID,
        email,
        connection: 'Username-Password-Authentication',
      }),
    })
    if (resetRes.ok) {
      passwordResetSent = true
    } else {
      console.error(
        '[auth0] change_password email failed:',
        resetRes.status,
        await resetRes.text(),
      )
    }
  } catch (err) {
    console.error('[auth0] change_password email threw:', err)
  }

  return { userId: created.user_id, created: true, passwordResetSent }
}
