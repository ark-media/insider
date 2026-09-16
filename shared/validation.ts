// Shared input-validation / output-encoding primitives. One audited definition
// per boundary so "valid email" and "escaped HTML" can't drift between routes.

// Loose RFC-shaped check — rejects obvious junk (whitespace, missing @/TLD)
// before an address reaches Stripe/Beehiiv/email sends. Downstream services
// validate canonical form; this just stops us minting rows for "  foo".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email)
}

// Redact an email for logs: keep the first character and the domain, mask the
// rest ("hannah@ark.com" → "h***@ark.com"). Fully masks addresses too short to
// partially reveal without exposing the local part.
export function redactEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 2) return '***'
  return `${email[0]}***${email.slice(at)}`
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
