// Beehiiv API v2 posts → NewsletterPost projection + HTML sanitizer.
// Lives outside dev-api.ts so the trust boundary (untrusted upstream HTML →
// allowlisted HTML safe for the client) is easy to read and easy to test in
// isolation. Mirrors `circle-broadcasts.ts`.
//
// The projection returns `NewsletterPost` directly — the same type the client
// consumes — so a field added to NewsletterPost surfaces as a type error here
// rather than silently disappearing on the wire.

import sanitizeHtml from 'sanitize-html'
import type {
  NewsletterPost,
  NewsletterSlug,
} from '../src/data/newsletters.js'

// Beehiiv's v2 post shape — only the fields we actually project.
// `audience` is what gates premium content; `content.free.web` is the HTML
// the email composer produced for the free-tier audience. Premium-only
// posts return their gated body in `content.premium.web`; we deliberately
// ignore that here so premium content never leaves the server even if the
// caller asks for it without authentication.
export type BeehiivPostContentVariant = {
  web?: string
  email?: string
  rss?: string
}

export type BeehiivPost = {
  id?: string
  title?: string
  subtitle?: string
  slug?: string
  status?: string
  audience?: 'free' | 'premium' | 'both' | string
  publish_date?: number | string
  displayed_date?: number | string
  preview_text?: string
  web_url?: string
  authors?: Array<{ name?: string } | string>
  content?: {
    free?: BeehiivPostContentVariant
    premium?: BeehiivPostContentVariant
  }
  // Older API responses sometimes return `content_html` flat.
  content_html?: string
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

// Allowlist tuned for Beehiiv's web HTML. Email composers emit a broader set
// of formatting than Circle Broadcasts — block quotes, headings down to h4,
// images, and horizontal rules are common. Keep the schema tight on <a> and
// <img> attributes.
export function sanitizeBeehiivHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr', 'a', 'strong', 'b', 'em', 'i',
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
  })
}

function toIsoDate(d: BeehiivPost['publish_date']): string {
  if (typeof d === 'number') {
    // Beehiiv ships publish_date as a unix epoch in seconds.
    return new Date(d * 1000).toISOString().slice(0, 10)
  }
  if (typeof d === 'string' && d) return d.slice(0, 10)
  return ''
}

function firstAuthorName(p: BeehiivPost, fallback: string): string {
  const a = p.authors?.[0]
  if (!a) return fallback
  if (typeof a === 'string') return a
  return a.name ?? fallback
}

export function isPublishedBeehiivPost(p: BeehiivPost): boolean {
  // Beehiiv post statuses observed: 'confirmed' (published), 'draft',
  // 'scheduled', 'archived'. Only 'confirmed' should reach the public site.
  if (p.status && p.status !== 'confirmed') return false
  return Boolean(p.id) && Boolean(p.publish_date || p.displayed_date)
}

export function projectBeehiivPost(
  p: BeehiivPost,
  newsletterSlug: NewsletterSlug,
  authorFallback: string,
): NewsletterPost | null {
  if (!p.id || !p.slug) return null
  const publishedAt = toIsoDate(p.publish_date ?? p.displayed_date)
  if (!publishedAt) return null

  // Use the free-audience HTML for projection. Premium-only posts may have
  // empty `content.free.web` — that's intentional; we surface a gated preview
  // (subtitle / preview_text) at the listing level and let the page-level
  // gate handle the rest. Never read from content.premium.web here.
  const rawHtml = p.content?.free?.web ?? p.content_html ?? ''
  const bodyHtml = sanitizeBeehiivHtml(rawHtml)
  const plain = stripHtml(rawHtml)

  const audience = (p.audience ?? 'free').toLowerCase()
  const tier: 'free' | 'ark-plus' =
    audience === 'premium' ? 'ark-plus' : 'free'

  const excerpt = (p.preview_text && p.preview_text.trim()) ||
    (p.subtitle && p.subtitle.trim()) ||
    plain.slice(0, 200)

  return {
    newsletterSlug,
    slug: p.slug,
    title: p.title ?? '(untitled)',
    publishedAt,
    excerpt,
    body: plain,
    bodyHtml,
    tier,
    authorName: firstAuthorName(p, authorFallback),
  }
}
