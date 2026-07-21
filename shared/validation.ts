// Shared input-validation / output-encoding primitives. One audited definition
// per boundary so "valid email" and "escaped HTML" can't drift between routes.

// Loose RFC-shaped check — rejects obvious junk (whitespace, missing @/TLD)
// before an address reaches Stripe/Beehiiv/email sends. Downstream services
// validate canonical form; this just stops us minting rows for "  foo".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email)
}

// Escape the five HTML-significant characters for safe interpolation into
// markup (attribute- and text-context safe).
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
