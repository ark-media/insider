// Circle Admin API v2 broadcasts → NewsletterPost projection + HTML sanitizer.
// Lives outside dev-api.ts so the trust boundary (untrusted upstream HTML →
// allowlisted HTML safe for the client) is easy to read and easy to test in
// isolation. Mirrors `show-notes.ts` for Simplecast.
//
// The projection returns `NewsletterPost` directly — the same type the client
// consumes — so a field added to NewsletterPost surfaces as a type error here
// rather than silently disappearing on the wire.

import sanitizeHtml from 'sanitize-html'
import { toIsoDate } from './lib/dates.js'
import type {
  NewsletterPost,
  NewsletterSlug,
} from '../src/data/newsletters.js'
import type { SanitizedHtml } from '../shared/sanitized-html.js'

export type CircleBroadcast = {
  id?: number | string
  // Circle's broadcast shape has drifted over versions and is not strictly
  // documented across plans. Accept any of these likely fields for each piece
  // of content and let the projection pick the first non-empty.
  name?: string
  subject?: string
  title?: string
  preview_text?: string
  email_body_html?: string
  body_html?: string
  html_body?: string
  body?: string
  sent_at?: string
  scheduled_at?: string
  created_at?: string
  status?: string
  tags?: Array<string | { name?: string }>
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// Allowlist for broadcast HTML. Circle's email composer emits a broader set of
// formatting than Simplecast show notes (images, headings, tables sometimes),
// but for the public newsletter surface we keep the allowlist tight — same
// tags as show notes plus <img> for embedded screenshots, which is the
// commonly-used extra.
export function sanitizeBroadcastHtml(html: string): SanitizedHtml {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'a', 'strong', 'b', 'em', 'i',
      'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'img',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
    },
  }) as SanitizedHtml
}

function tagNames(tags: CircleBroadcast['tags']): string[] {
  if (!tags) return []
  return tags
    .map((t) => (typeof t === 'string' ? t : (t.name ?? '')))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
}

// Build a stable, URL-safe slug from a broadcast id. Circle ids are stable;
// using them directly avoids collisions and the headaches of deriving slugs
// from subjects (which can change after send).
export function broadcastSlug(id: number | string): string {
  return `broadcast-${String(id)}`
}

export function projectBroadcast(
  b: CircleBroadcast,
  newsletterSlug: NewsletterSlug,
  authorName: string,
): NewsletterPost | null {
  if (b.id === undefined || b.id === null) return null
  // Drop unsent broadcasts — they would publish drafts to the public site.
  const publishedAt = toIsoDate(b.sent_at ?? b.scheduled_at ?? b.created_at)
  if (!publishedAt) return null

  const rawHtml = b.email_body_html ?? b.body_html ?? b.html_body ?? b.body ?? ''
  const bodyHtml = sanitizeBroadcastHtml(rawHtml)
  const plain = stripHtml(rawHtml)

  const title = b.subject ?? b.name ?? b.title ?? '(untitled)'
  const excerpt = (b.preview_text && b.preview_text.trim()) ||
    plain.slice(0, 200)

  // A "members-only" tag on the broadcast escalates a post to ark-plus tier.
  // Anything else stays free — Circle Broadcasts have no native tier concept,
  // so editorial signals it via tagging.
  const tags = tagNames(b.tags)
  const tier: 'free' | 'ark-plus' = tags.includes('members-only')
    ? 'ark-plus'
    : 'free'

  return {
    newsletterSlug,
    slug: broadcastSlug(b.id),
    title,
    publishedAt,
    excerpt,
    body: plain,
    bodyHtml,
    tier,
    authorName,
  }
}

export function isSentBroadcast(b: CircleBroadcast): boolean {
  if (b.status && b.status !== 'sent') return false
  return Boolean(b.sent_at) || Boolean(b.scheduled_at) || Boolean(b.created_at)
}
