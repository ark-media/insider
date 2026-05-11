type TokenGetter = () => Promise<string>

let _get: TokenGetter | null = null

// Short-lived token issued by /api/auth/checkout-session so a brand-new
// subscriber is logged in immediately after payment, without round-tripping
// through the password-reset email. After it expires the user logs in
// normally via Auth0 using the password they set from that email.
const CHECKOUT_SESSION_KEY = 'ark.checkoutSession'

type StoredCheckoutSession = {
  token: string
  expiresAt: number
}

function readCheckoutSession(): StoredCheckoutSession | null {
  try {
    const raw = localStorage.getItem(CHECKOUT_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredCheckoutSession
    if (!parsed.token || typeof parsed.expiresAt !== 'number') return null
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(CHECKOUT_SESSION_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function setCheckoutSession(token: string, expiresInSec: number) {
  localStorage.setItem(
    CHECKOUT_SESSION_KEY,
    JSON.stringify({
      token,
      expiresAt: Date.now() + expiresInSec * 1000,
    } satisfies StoredCheckoutSession),
  )
}

export function clearCheckoutSession() {
  localStorage.removeItem(CHECKOUT_SESSION_KEY)
}

export function hasCheckoutSession(): boolean {
  return readCheckoutSession() !== null
}

export function setTokenGetter(fn: TokenGetter) {
  _get = fn
}

export async function getToken(): Promise<string | null> {
  const checkout = readCheckoutSession()
  if (checkout) return checkout.token
  if (!_get) return null
  try {
    return await _get()
  } catch {
    return null
  }
}
