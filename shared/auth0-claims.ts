// Shared between client and server. Custom-claim namespace is a URL-shaped
// identifier required by Auth0 for non-OIDC-standard claims. It is decoupled
// from the login domain — when the login domain moves (e.g. tenant migration),
// the claim namespace usually stays put so older tokens stay decodable.
// Update this single constant to roll over all derived strings.

export const AUTH0_CLAIM_NAMESPACE = 'https://ark-plus.xyz'
export const AUTH0_AUDIENCE = `${AUTH0_CLAIM_NAMESPACE}/api`
export const AUTH0_EMAIL_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/email`
export const AUTH0_TIER_CLAIM = `${AUTH0_CLAIM_NAMESPACE}/tier`
