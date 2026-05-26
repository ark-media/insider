// Beehiiv API v2 posts → NewsletterPost projection + HTML sanitizer.
// Lives outside dev-api.ts so the trust boundary (untrusted upstream HTML →
// allowlisted HTML safe for the client) is easy to read and easy to test in
// isolation. Mirrors `circle-broadcasts.ts`.
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
  // Drop <style>/<script> block *contents* before tag-stripping. Beehiiv's
  // web HTML ships with a dozen+ theme `<style>` blocks; if we only strip
  // the tags, the CSS body survives as raw text and leaks into the excerpt.
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
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
// Beehiiv auto-injects a default author avatar (a gradient sphere PNG) when
// the post's author has no custom avatar set. It's chrome, not editorial,
// so we drop it before it reaches the page.
const BEEHIIV_DEFAULT_AVATAR_RE = /\/static_assets\/gradient_avatar_/i

export function sanitizeBeehiivHtml(html: string): SanitizedHtml {
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
    exclusiveFilter: (frame) =>
      frame.tag === 'img' &&
      BEEHIIV_DEFAULT_AVATAR_RE.test(frame.attribs?.src ?? ''),
  }) as SanitizedHtml
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
  view: 'free' | 'premium' = 'free',
): NewsletterPost | null {
  if (!p.id || !p.slug) return null
  const publishedAt = toIsoDate(p.publish_date ?? p.displayed_date)
  if (!publishedAt) return null

  // `view: 'free'` picks the above-divider HTML (or the whole body for
  // `audience: 'free'` posts). `view: 'premium'` picks the full premium body
  // and falls back to free.web when no premium variant is present (e.g.
  // pure-free posts that a member happens to request). Callers are responsible
  // for only requesting `premium` after authenticating an Ark+ reader — this
  // function trusts that decision.
  const rawHtml =
    view === 'premium'
      ? p.content?.premium?.web?.trim() ||
        p.content?.free?.web ||
        p.content_html ||
        ''
      : p.content?.free?.web ?? p.content_html ?? ''
  const bodyHtml = sanitizeBeehiivHtml(rawHtml)
  const plain = stripHtml(rawHtml)

  // Tier reflects "is this gated on the surface that requested it?" — not the
  // post's intrinsic audience. A `both`-audience post is the free version on
  // ark-daily (above-divider IS the published version), but the paywalled
  // version on members-letter (members see full, others see the preview).
  const audience = (p.audience ?? 'free').toLowerCase()
  let tier: 'free' | 'ark-plus' = 'free'
  if (audience === 'premium') {
    tier = 'ark-plus'
  } else if (audience === 'both') {
    tier = newsletterSlug === 'members-letter' ? 'ark-plus' : 'free'
  }

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
    beehiivPostId: p.id,
  }
}
