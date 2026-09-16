// Auth0 user creation after a successful payment. The clients live in
// ../auth0.ts; this module does the find-or-create dance.
//
// It used to also hand back a first-login path — Auth0's own password-reset
// email, or a password-change ticket for the gift flow. Neither exists now:
// password sign-in was removed from the login page on 2026-09-16 (see
// auth0/README.md), so a credential minted here would be one the member could
// never use. The account is created on the Database connection and the login
// page mails a one-time code against that address; callers carry members in
// with the auto-login links in their own email (server/lib/session.ts).

import crypto from 'node:crypto'
import { getManagementClient } from '../auth0.js'
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

// `created` distinguishes a brand-new account from a pre-existing one. Callers
// use it to pick welcome-email copy — a new member needs telling that the link
// signs them in, an existing one that there is no second account.
export type Auth0UserResult = {
  userId: string
  created: boolean
}

export async function findOrCreateAuth0User(
  email: string,
  nameHint: string | undefined,
  env: Env,
  // `emailVerified` creates the account with email_verified:true. The gift
  // magic-link flow sets it: the recipient clicked a link delivered to their
  // inbox, which proves control of the address — and creating the user
  // pre-verified suppresses Auth0's own "Verify your email" message (which
  // otherwise fires on every email_verified:false creation).
  opts: { emailVerified?: boolean } = {},
): Promise<Auth0UserResult | null> {
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
    return { userId: found.user_id, created: false }
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

  // The record carries only a random temp password, and nothing will ever ask
  // for it: the member signs in with an emailed code against this address, or
  // with Google if it matches. What this account exists for is to be the
  // canonical identity the post-login action links those logins into.
  return { userId, created: true }
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

