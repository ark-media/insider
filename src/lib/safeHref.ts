// Anchor-href scheme allowlist for rendering remote HTML.
//
// The server sanitizers (server/beehiiv-posts.ts, server/show-notes.ts,
// server/circle-broadcasts.ts, server/lib/richText.ts) all set
// allowedSchemes: ['http','https','mailto'], so by the time HTML reaches a
// renderer a javascript:/data: href should already be gone. This is the second
// line of defense: it means a regression in ONE sanitizer config can't become a
// clickable script URL, and it keeps both renderers honest about the same rule.
//
// Shared rather than duplicated because the two renderers had drifted — the
// newsletter one validated, the show-notes one didn't.
const SAFE_HREF_RE = /^(?:https?:|mailto:|#)/i;

export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  return SAFE_HREF_RE.test(trimmed) ? trimmed : undefined;
}
