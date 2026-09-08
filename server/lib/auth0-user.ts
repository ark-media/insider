// Auth0 user creation after a successful payment. The clients live in
// ../auth0.ts; this module does the find-or-create dance and gets a first-login
// path to the new member — either Auth0's own password-reset email (default)
// or, for the gift flow, a password-change ticket URL the caller embeds in its
// own welcome email.

import crypto from 'node:crypto'
import { getAuthenticationClient, getManagementClient } from '../auth0.js'
import {
  MAX_NAME_PART_LEN,
  hasRealName,
  splitFullName,
} from '../../shared/profile-name.js'

// app_metadata key recording that a name came from the member, not from a
// backfill, a billing form, or the old email-local-part fallback. Auth0 is
// already the name's home, so its provenance lives beside it rather than in a
// new Neon column (membership stores no PII). shared/profile-name explains why
// the shape of a name alone can't answer the question.
const NAME_SET_BY_MEMBER_KEY = 'name_set_by_member'

// Reads that flag off a Management API user record.
function nameSetByMember(user: { app_metadata?: unknown }): boolean {
  return (
    (user.app_metadata as Record<string, unknown> | undefined)?.[
      NAME_SET_BY_MEMBER_KEY
    ] === true
  )
}

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

  // Only write a name we were actually given. This used to fall back to
  // `email.split('@')[0]`, which is why the migrated roster is full of members
  // called "hannah.waxman8" — a value indistinguishable from a real name at
  // every downstream read. Auth0 doesn't require given_name, so leaving it
  // unset is both honest and what lets `hasRealName` spot the gap.
  const { first: givenName, last: familyName } = splitFullName(nameHint)
  const hintIsReal = hasRealName({ givenName, familyName, email })

  // Return early if Auth0 user already exists — but not before filling an empty
  // name from the hint. The hint used to be read only on the create branch
  // below, so a reader who already had a login (a free newsletter subscriber,
  // say) kept whatever Auth0 held when they later paid, even though they typed
  // a real name into Stripe checkout: it reached Beehiiv and their welcome email
  // and stopped there, while /account went on asking them for a name they had
  // already given us.
  //
  // Strictly gap-filling. Any real name already on the record wins — including
  // one the member typed, which `hasRealName` honours via app_metadata — and the
  // write is deliberately NOT flagged setByMember, because a name harvested from
  // a billing form is still a guess and should stay subject to the heuristic.
  const existing = await mgmt.users.listUsersByEmail({ email })
  const found = existing[0]
  if (found?.user_id) {
    const storedIsReal = hasRealName({
      givenName: found.given_name,
      familyName: found.family_name,
      email,
      setByMember: nameSetByMember(found),
    })
    if (!storedIsReal && hintIsReal && givenName) {
      // Soft-fail by design: updateAuth0Name logs and returns false rather than
      // throwing. A name is not worth failing provisioning over.
      await updateAuth0Name(env, found.user_id, { givenName, familyName })
    }
    return { userId: found.user_id, created: false, passwordResetSent: false }
  }

  // Create Auth0 user with a random temporary password — the password-change
  // email below is how they'll actually log in for the first time.
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
  // Whether the member typed this name themselves — see NAME_SET_BY_MEMBER_KEY.
  setByMember: boolean
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
      setByMember: nameSetByMember(user),
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
  // Set only when the member typed this name into the account form. Records
  // provenance in app_metadata so a later read can't re-judge it manufactured.
  // The backfill deliberately leaves it off: a harvested name is still a guess,
  // and should stay subject to the heuristic.
  opts: { setByMember?: boolean } = {},
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
      // Auth0 validates the root name attributes as minLength 1, so sending
      // `family_name: ''` 400s the entire write — which would fail every mononym
      // save, not just the surname. Omit the key instead, exactly as the create
      // path above does. (The API offers no way to *clear* a surname once set:
      // '' is rejected and the SDK types don't admit null. A member deleting
      // theirs keeps it in Auth0, which is a stale field rather than a blocked
      // save — the lesser of the two.)
      ...(familyName ? { family_name: familyName } : {}),
      name: [givenName, familyName].filter(Boolean).join(' '),
      // Auth0 merges app_metadata at the top level, so writing this one key
      // leaves the tier mirror sitting beside it untouched.
      ...(opts.setByMember
        ? { app_metadata: { [NAME_SET_BY_MEMBER_KEY]: true } }
        : {}),
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

// Send Auth0's own branded "reset your password" email to a member who asked
// for one from the account page. Distinct from createAuth0PasswordChangeTicket
// above: that one mints a URL for us to put inside our own email, which is
// right when we're already sending one (the gift welcome). Here the member is
// sitting on the account page and nothing else is going out, so Auth0's email
// — whose template is configured on the login client — is the whole delivery.
//
// Returns false on any failure so the caller can say so, rather than claiming
// an email is on its way when nothing was sent.
export async function sendAuth0PasswordResetEmail(
  email: string,
  env: Env,
): Promise<boolean> {
  try {
    await getAuthenticationClient(env).database.changePassword({
      email,
      connection: 'Username-Password-Authentication',
    })
    return true
  } catch (err) {
    console.error('[auth0] password reset email failed:', err)
    return false
  }
}
