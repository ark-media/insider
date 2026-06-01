import sanitizeHtml from 'sanitize-html'

// Shared sanitizer for all admin-authored rich text — FAQ answers, job
// descriptions, and announcement bodies. One allowlist so every editor in the
// back office offers, and persists, the exact same formatting (the WYSIWYG
// toolbar in src/components/RichTextEditor.tsx mirrors this set).
//
// Scripts, styles, images, iframes, and event handlers are stripped; links are
// forced to open safely in a new tab. This is the authoritative security
// boundary — the client preview only approximates it.
export const RICH_TEXT_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a',
  'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote',
]

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: RICH_TEXT_ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
    },
  })
}
