// Shared between client and server. Custom-claim namespace is a URL-shaped
// identifier required by Auth0 for non-OIDC-standard claims. It is decoupled
// from the login domain — when the login domain moves (e.g. tenant migration),
// the claim namespace usually stays put so older tokens stay decodable.
// Update this single constant to roll over all derived strings.

export const AUTH0_CLAIM_NAMESPACE = 'https://ark-plus.xyz'
export const AUTH0_AUDIENCE = `${AUTH0_CLAIM_NAMESPACE}/api`
export const AUTH0_EMAIL_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/email`
// No tier claim: Auth0 carries no entitlement (tasks/entitlement-tiers.md §2).
// Access is a live Neon read keyed on the sub, never a token claim.
// Array-of-strings claim carrying the user's role names (e.g. ["admin"]).
// Emitted by the Auth0 Login Action from the user's assigned RBAC roles
// (event.authorization.roles). Absent for non-admins. Gates the back office.
export const AUTH0_ROLES_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/roles`
