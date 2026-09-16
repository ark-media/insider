// Compile-time brand for HTML strings that have passed through an
// allowlist sanitizer. The brand is purely a TypeScript invariant — at
// runtime SanitizedHtml is a plain string, and JSON round-trip preserves it
// — but it means a caller can't pass raw, untrusted HTML to a renderer
// without an explicit cast that surfaces in code review.
//
// Producers:
//   - sanitizeBeehiivHtml   (server/beehiiv-posts.ts)
//   - sanitizeBroadcastHtml (server/circle-broadcasts.ts)
//
// Consumers must declare the input as SanitizedHtml, not string.

declare const sanitizedHtmlBrand: unique symbol
export type SanitizedHtml = string & { readonly [sanitizedHtmlBrand]: true }

/**
 * Escape-hatch for the rare path that legitimately has sanitized HTML but
 * lost the type (e.g. JSON round-trip across an API boundary). Wraps the
 * cast in a named function so audits can grep `unsafeAssumeSanitized` and
 * inspect every caller.
 */
export function unsafeAssumeSanitized(html: string): SanitizedHtml {
  return html as SanitizedHtml
}
