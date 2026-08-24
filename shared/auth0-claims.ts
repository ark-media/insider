// Shared between client and server. Custom-claim namespace is a URL-shaped
// identifier required by Auth0 for non-OIDC-standard claims. It is decoupled
// from the login domain — when the login domain moves (e.g. tenant migration),
// the claim namespace usually stays put so older tokens stay decodable.
// Update this single constant to roll over all derived strings.

const AUTH0_CLAIM_NAMESPACE = 'https://ark-plus.xyz'
export const AUTH0_AUDIENCE = `${AUTH0_CLAIM_NAMESPACE}/api`
export const AUTH0_EMAIL_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/email`
// No tier claim: Auth0 carries no entitlement (tasks/entitlement-tiers.md §2).
// Access is a live Neon read keyed on the sub, never a token claim.
// Array-of-strings claim carrying the user's role names (e.g. ["admin"]).
// Emitted by the Auth0 Login Action from the user's assigned RBAC roles
// (event.authorization.roles). Absent for non-admins. Gates the back office.
export const AUTH0_ROLES_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/roles`
// The member's name, mirrored from the Auth0 user's root profile by the Login
// Action so the session carries it without a Management API read on every
// request. Namespaced like the rest: Auth0 silently drops custom claims that
// aren't URL-shaped, which is why a bare `name` read never worked here.
// Refreshed only at login — the profile save re-mints the session cookie so an
// edit shows immediately, and a backfilled name self-heals on next sign-in.
export const AUTH0_GIVEN_NAME_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/given_name`
export const AUTH0_FAMILY_NAME_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/family_name`
// Boolean claim mirroring app_metadata.name_set_by_member — true when the member
// typed the name above rather than it being harvested or manufactured from their
// email. shared/profile-name explains why the name's characters alone can't
// answer that. The Login Action must emit it (`event.user.app_metadata
// ?.name_set_by_member === true`); until it does, this reads false at login and
// the heuristic decides, which is the pre-existing behaviour. The profile save
// re-mints the session cookie with it set, so an edit is never waiting on a
// login for its own greeting.
export const AUTH0_NAME_SET_BY_MEMBER_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/name_set_by_member`
