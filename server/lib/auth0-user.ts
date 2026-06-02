// Auth0 user creation after a successful payment. The clients live in
// ../auth0.ts; this module does the find-or-create dance and gets a first-login
// path to the new member — either Auth0's own password-reset email (default)
// or, for the gift flow, a password-change ticket URL the caller embeds in its
// own welcome email.

import crypto from 'node:crypto'
import { getAuthenticationClient, getManagementClient } from '../auth0.js'

type Env = Record<string, string>

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
  // The gift path passes { emailPasswordReset: false } because it sends its
  // own branded welcome email carrying a password-change ticket instead — see
  // createAuth0PasswordChangeTicket below. The subscription path leaves this
  // default so its change_password email keeps going out.
  opts: { emailPasswordReset?: boolean } = {},
): Promise<Auth0UserResult | null> {
  const emailPasswordReset = opts.emailPasswordReset ?? true
  const mgmt = getManagementClient(env)
  if (!mgmt) return null

  // Return early if Auth0 user already exists.
  const existing = await mgmt.users.listUsersByEmail({ email })
  if (existing.length > 0 && existing[0].user_id) {
    return { userId: existing[0].user_id, created: false, passwordResetSent: false }
  }

  // Create Auth0 user with a random temporary password — the password-change
  // email below is how they'll actually log in for the first time.
  const spaceIdx = (nameHint ?? '').indexOf(' ')
  const givenName = spaceIdx > -1 ? nameHint!.slice(0, spaceIdx) : (nameHint ?? '')
  const familyName = spaceIdx > -1 ? nameHint!.slice(spaceIdx + 1) : ''
  const tempPassword = `Tmp-${crypto.randomBytes(16).toString('hex')}`

  let userId: string | undefined
  try {
    const created = await mgmt.users.create({
      connection: 'Username-Password-Authentication',
      email,
      password: tempPassword,
      given_name: (givenName || email.split('@')[0]).slice(0, 40),
      ...(familyName ? { family_name: familyName.slice(0, 40) } : {}),
      email_verified: false,
    })
    userId = created.user_id
  } catch (err) {
    console.error('[auth0] create user failed:', err)
    return null
  }
  if (!userId) {
    console.error('[auth0] create user returned no user_id')
    return null
  }

  // Caller opted out of the Auth0 email (it will deliver the password-change
  // link itself). The account exists with only a temp password; the caller is
  // responsible for getting a set-password link to the user.
  if (!emailPasswordReset) {
    return { userId, created: true, passwordResetSent: false }
  }

  // The user record exists but has only the random temp password. Without
  // the change_password email going through, they have no way to sign in —
  // surface this so the caller can flag for manual support resend.
  let passwordResetSent = false
  try {
    await getAuthenticationClient(env).database.changePassword({
      email,
      connection: 'Username-Password-Authentication',
    })
    passwordResetSent = true
  } catch (err) {
    console.error('[auth0] change_password email failed:', err)
  }

  return { userId, created: true, passwordResetSent }
}

// Mints a password-change ticket (a self-contained URL) via the Management API
// instead of triggering Auth0's own email. Used by the gift flow so the
// set-password link can ride inside our single branded welcome email. The M2M
// app must hold the `create:user_tickets` scope. `resultUrl` is where Auth0
// redirects after the password is set. Returns the ticket URL, or null on any
// failure (caller soft-fails — the gift is already granted).
export async function createAuth0PasswordChangeTicket(
  userId: string,
  resultUrl: string,
  env: Env,
): Promise<string | null> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return null

  try {
    const ticket = await mgmt.tickets.changePassword({
      user_id: userId,
      result_url: resultUrl,
      mark_email_as_verified: true,
    })
    return ticket.ticket ?? null
  } catch (err) {
    console.error('[auth0] password-change ticket failed:', err)
    return null
  }
}
