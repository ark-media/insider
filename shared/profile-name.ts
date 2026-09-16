// The one place a member's name is parsed, judged, and rendered — on the client
// and the server.
//
// The whole module exists because of one legacy behaviour: for most of this
// site's life we *manufactured* a name whenever we didn't have one.
// `findOrCreateAuth0User` writes `given_name: email.split('@')[0]` when it has
// nothing better, and that value propagates outward to every store that greets
// the member. So "no name" does not present as an empty field — it presents as
// a member whose name is literally "hannah.waxman8".
//
// That makes `!givenName` the wrong test everywhere. Asking "do we have a real
// name?" has to mean "do we have one a human typed?", and every caller — the
// account prompt, the backfill filter, and every email greeting — must ask it
// the same way, or we greet thousands of people as "Hi hannah.waxman8,".
//
// The tell is that an auto-filled value is the local part *verbatim*: same
// characters, same lowercase, digits and dots included. A person typing their
// own name capitalizes it. So a value that matches the local part but carries a
// capital ("Hannah" for hannah@…) is treated as real, which keeps the
// legitimately-named-like-your-email case out of the prompt loop. A value with a
// surname beside it is always real, since we never manufactured a family name.
//
// The heuristic has one blind spot it cannot close on its own: "sarah", typed by
// sarah@gmail.com, is character-for-character what we would have manufactured
// for her. Provenance settles that case — `setByMember` says a human typed this
// into the account form, and nothing about its shape can overrule that. Without
// it her save reads as manufactured on the very next request: the prompt returns
// with the form seeded blank and /api/me stops greeting her by name.

// Auth0 root attributes are capped in practice and the create path already
// truncated to 40; keep every writer agreeing on one bound.
export const MAX_NAME_PART_LEN = 40

export type NameParts = { first?: string; last?: string }

export type NameInput = {
  givenName?: string | null
  familyName?: string | null
  email?: string | null
  // True when the member typed this name themselves. Written to the Auth0 user's
  // app_metadata by PUT /api/account/profile, read back by every authoritative
  // read, and mirrored into the session cookie so the greeting doesn't wait for
  // a Management call. Absent everywhere a name was harvested or manufactured,
  // which is exactly where the heuristic below still has to do the work.
  setByMember?: boolean | null
}

/**
 * Split a single display name into first + last on the *first* space, so
 * "Ada Lovelace King" keeps "Lovelace King" together as the surname.
 *
 * Both parts come back trimmed and length-capped, and an absent part is
 * `undefined` rather than '' so callers can spread it into an API body without
 * writing empty strings over real data.
 */
export function splitFullName(full?: string | null): NameParts {
  const value = (full ?? '').trim().replace(/\s+/g, ' ')
  if (!value) return {}
  const spaceIdx = value.indexOf(' ')
  const first = (spaceIdx > -1 ? value.slice(0, spaceIdx) : value).slice(
    0,
    MAX_NAME_PART_LEN,
  )
  const last =
    spaceIdx > -1 ? value.slice(spaceIdx + 1).slice(0, MAX_NAME_PART_LEN) : ''
  return { first: first || undefined, last: last || undefined }
}

// Compare on alphanumerics only, so "hannah.waxman8" and "hannahwaxman8" are
// recognised as the same manufactured value.
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function localPartOf(email: string): string {
  const at = email.indexOf('@')
  return at > -1 ? email.slice(0, at) : email
}

/**
 * True when `value` is just the email's local part wearing a name's clothes —
 * the shape `findOrCreateAuth0User` writes when no real name is known. Also true for a value that still contains '@', which is a
 * whole address that leaked into a name field.
 *
 * This is the raw comparison, with no judgement about capitalization; the
 * backfill wants it this way to reject manufactured `first_name` values. For the "should we prompt / can we greet?" question use
 * `hasRealName`, which is stricter.
 */
export function looksLikeEmailLocalPart(
  value: string | null | undefined,
  email: string | null | undefined,
): boolean {
  const name = (value ?? '').trim()
  if (!name) return false
  if (name.includes('@')) return true
  const addr = (email ?? '').trim()
  if (!addr) return false
  const local = normalize(localPartOf(addr))
  return local.length > 0 && normalize(name) === local
}

/**
 * True when we hold a name a human actually gave us.
 *
 * `setByMember` is proof outright: they typed it. A surname is proof too — we
 * never manufactured one. Otherwise a lone first name is real unless it's the
 * email local part verbatim *and* lowercase, which is exactly the auto-filled
 * shape.
 */
export function hasRealName({
  givenName,
  familyName,
  email,
  setByMember,
}: NameInput): boolean {
  const given = (givenName ?? '').trim()
  if (!given) return false
  // An address is never a name, whoever supplied it and however it is
  // capitalized. This has to precede both the provenance and the capitalization
  // rules below, or "Hannah@example.com" — free text a giver can type into the
  // gift form's recipient_name — reads as real and renders as a greeting.
  if (given.includes('@')) return false
  // Recorded provenance beats any inference drawn from the characters.
  if (setByMember) return true
  const family = (familyName ?? '').trim()
  if (family && !family.includes('@')) return true
  if (!looksLikeEmailLocalPart(given, email)) return true
  // Matches the local part — real only if it was typed, which we infer from a
  // capital the auto-filled value could never have.
  return given !== given.toLowerCase()
}

/**
 * The name to greet someone by ("Hi Hannah,"), or `undefined` when we have
 * nothing trustworthy — in which case callers keep their "Hi there," fallback.
 * Never returns a manufactured local part.
 */
export function greetingFirstName(
  givenName: string | null | undefined,
  email: string | null | undefined,
  familyName?: string | null,
  setByMember?: boolean | null,
): string | undefined {
  if (!hasRealName({ givenName, familyName, email, setByMember })) return undefined
  // Take the leading token rather than the field verbatim: a "first name" field
  // does not reliably hold one. A provider's `first_name` carries whatever
  // single hint created the user, so a member provisioned from a Stripe customer
  // called "Hannah Waxman" has that whole string in it — and the tell is a
  // reminder email that opens "Hi Hannah Waxman,".
  const [first] = (givenName ?? '').trim().split(' ')
  return first || undefined
}

/**
 * The full display name ("Hannah Waxman"), or `undefined` when no real name is
 * held. Used for the session's `name`, the account row, and Auth0's root `name`.
 */
export function displayName({
  givenName,
  familyName,
  email,
  setByMember,
}: NameInput): string | undefined {
  if (!hasRealName({ givenName, familyName, email, setByMember })) return undefined
  const joined = [(givenName ?? '').trim(), (familyName ?? '').trim()]
    .filter(Boolean)
    .join(' ')
  return joined || undefined
}
