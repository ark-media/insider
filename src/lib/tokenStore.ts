type TokenGetter = () => Promise<string>

let _get: TokenGetter | null = null

export function setTokenGetter(fn: TokenGetter) {
  _get = fn
}

// Returns the Auth0 access token when an Auth0 session exists, or null. The
// brand-new-subscriber session (issued by /api/auth/checkout-session) lives
// in an httpOnly cookie that JS cannot read — those requests rely on
// credentials: 'include' instead of a Bearer header.
export async function getToken(): Promise<string | null> {
  if (!_get) return null
  try {
    return await _get()
  } catch {
    return null
  }
}

// Non-httpOnly companion cookie set by /api/auth/checkout-session purely as a
// presence signal — the real session token is in the sibling httpOnly cookie.
// Used to gate "should we attempt fetchMe()" before Auth0 resolves.
const PRESENT_COOKIE_NAME = 'ark_checkout_present'

export function hasCheckoutCookie(): boolean {
  if (typeof document === 'undefined') return false
  return document.cookie
    .split(';')
    .some((c) => c.trim().startsWith(`${PRESENT_COOKIE_NAME}=`))
}
