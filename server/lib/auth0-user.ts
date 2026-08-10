// Auth0 user creation after a successful payment. The clients live in
// ../auth0.ts; this module does the find-or-create dance and gets a first-login
// path to the new member — either Auth0's own password-reset email (default)
// or, for the gift flow, a password-change ticket URL the caller embeds in its
// own welcome email.

import crypto from 'node:crypto'
import { getAuthenticationClient, getManagementClient } from '../auth0.js'
import {
  MAX_NAME_PART_LEN,
  splitFullName,
} from '../../shared/profile-name.js'

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
  //
  // `emailVerified` creates the account with email_verified:true. The gift
  // magic-link flow sets it: the recipient clicked a link delivered to their
  // inbox, which proves control of the address — and creating the user
  // pre-verified suppresses Auth0's own "Verify your email" message (which
  // otherwise fires on every email_verified:false creation).
  opts: { emailPasswordReset?: boolean; emailVerified?: boolean } = {},
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
  // Only write a name we were actually given. This used to fall back to
  // `email.split('@')[0]`, which is why the migrated roster is full of members
  // called "hannah.waxman8" — a value indistinguishable from a real name at
  // every downstream read. Auth0 doesn't require given_name, so leaving it
  // unset is both honest and what lets `hasRealName` spot the gap.
  const { first: givenName, last: familyName } = splitFullName(nameHint)
  const tempPassword = `Tmp-${crypto.randomBytes(16).toString('hex')}`

  let userId: string | undefined
  try {
    const created = await mgmt.users.create({
      connection: 'Username-Password-Authentication',
      email,
      password: tempPassword,
      ...(givenName ? { given_name: givenName.slice(0, MAX_NAME_PART_LEN) } : {}),
      ...(familyName ? { family_name: familyName.slice(0, MAX_NAME_PART_LEN) } : {}),
      email_verified: opts.emailVerified ?? false,
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

// Look up a user's email and name by their Auth0 `sub`/user_id via the
// Management API. Membership rows store only the opaque sub (no PII), so the
// gift-expiry reminder cron resolves both the recipient's address and their
// name here at send time — one lookup, which is what that cron already spent.
//
// (Supersedes an email-only helper; the cron was its sole caller and it needs
// the name too, so returning both keeps the call count unchanged.)
export type Auth0NameProfile = {
  email: string | null
  givenName: string | null
  familyName: string | null
}

// One Management read of a user's name + email. Returns null on any failure so
// callers keep their soft-fail branches.
export async function getAuth0NameProfile(
  env: Env,
  userId: string,
): Promise<Auth0NameProfile | null> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return null
  try {
    const user = await mgmt.users.get(userId)
    return {
      email: user.email?.trim() || null,
      givenName: user.given_name?.trim() || null,
      familyName: user.family_name?.trim() || null,
    }
  } catch (err) {
    console.error('[auth0] name profile lookup failed:', err)
    return null
  }
}

// Writes the member's name onto their Auth0 user. Root `name` is set alongside
// given/family so the dashboard, the Login Action's claim source, and any
// future name-consumer can't disagree.
//
// The target is always the primary Database-connection user: the Login Action
// calls setPrimaryUser on the record carrying the DB identity, and denies social
// self-signup outright, so a session `sub` is an `auth0|…` id. Root attributes
// are read-only on social identities, so if that invariant ever slips Auth0
// answers 400 — surfaced as `false` rather than a silent no-op, because the
// caller must not tell the member their name was saved when it wasn't.
export async function updateAuth0Name(
  env: Env,
  userId: string,
  name: { givenName: string; familyName?: string },
): Promise<boolean> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return false

  if (!userId.startsWith('auth0|')) {
    console.warn(
      `[auth0] name write targeting a non-database primary (${userId.split('|')[0]}); root attributes may be provider-controlled`,
    )
  }

  const givenName = name.givenName.trim().slice(0, MAX_NAME_PART_LEN)
  const familyName = (name.familyName ?? '').trim().slice(0, MAX_NAME_PART_LEN)

  try {
    await mgmt.users.update(userId, {
      given_name: givenName,
      family_name: familyName,
      name: [givenName, familyName].filter(Boolean).join(' '),
    })
    return true
  } catch (err) {
    console.error('[auth0] name update failed:', err)
    return false
  }
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
