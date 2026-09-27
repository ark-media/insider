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
type BeehiivPostContentVariant = {
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

function stripHtml(html: string): string {
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

// Tags with no place in a static, script-free document: anything that runs
// code, embeds another context, submits, or reaches outside the frame
// (`<base>`, `<meta http-equiv=refresh>`). `<link>` only pulls Beehiiv's
// Google Fonts stylesheet, whose family ("Helvetica") doesn't exist there.
const DOCUMENT_DROPPED_TAGS = new Set([
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'form', 'input', 'textarea', 'select', 'link', 'meta', 'base',
  'title',
])

// The page's own strip carries the title, byline and date; Beehiiv's header
// repeats them (plus share buttons to the beehiiv.com copy) at a size that
// pushes the issue's masthead below the fold. Links open outside the frame,
// which is sandboxed without navigation of the top window.
const DOCUMENT_HEAD =
  '<base target="_blank">' +
  '<style>#web-header{display:none!important}html,body{margin:0}</style>'

/**
 * Beehiiv's web HTML kept whole — its own styles and layout — for rendering
 * inside a sandboxed iframe (`<NewsletterFrame>`), so the issue looks the way
 * it does on Beehiiv. Unlike `sanitizeBeehiivHtml` this keeps every tag and
 * attribute except the ones that execute or escape: scripts, event handlers,
 * embeds, forms, and non-http(s)/mailto urls. The iframe's sandbox (no
 * `allow-scripts`) is the second wall, not the only one.
 */
export function sanitizeBeehiivDocument(html: string): SanitizedHtml {
  const body = sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    exclusiveFilter: (frame) => DOCUMENT_DROPPED_TAGS.has(frame.tag),
    transformTags: {
      '*': (tagName, attribs) => ({
        tagName,
        attribs: Object.fromEntries(
          Object.entries(attribs).filter(([k]) => !/^on/i.test(k)),
        ),
      }),
    },
  })
  const withHead = /<head[^>]*>/i.test(body)
    ? body.replace(/<head[^>]*>/i, (m) => m + DOCUMENT_HEAD)
    : DOCUMENT_HEAD + body
  return `<!doctype html>${withHead}` as SanitizedHtml
}

function firstAuthorName(p: BeehiivPost, fallback: string): string {
  const a = p.authors?.[0]
  if (!a) return fallback
  if (typeof a === 'string') return a
  return a.name ?? fallback
}

const HEADER_DATE_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}\b/gi

// True when nothing is left of the free edition once the header — title,
// subtitle, author names, publish date — is taken out.
function freeIsHeaderOnly(freeText: string, p: BeehiivPost): boolean {
  let rest = freeText.replace(HEADER_DATE_RE, ' ')
  const names = (p.authors ?? []).map((a) =>
    typeof a === 'string' ? a : (a.name ?? ''),
  )
  for (const part of [p.title, p.subtitle, ...names]) {
    const t = part?.trim()
    if (t) rest = rest.split(t).join(' ')
  }
  return rest.trim() === ''
}

export function isPublishedBeehiivPost(p: BeehiivPost): boolean {
  // Beehiiv post statuses observed: 'confirmed' (published), 'draft',
  // 'scheduled', 'archived'. Only 'confirmed' should reach the public site.
  if (p.status && p.status !== 'confirmed') return false
  return Boolean(p.id) && Boolean(p.publish_date || p.displayed_date)
}

// `view: 'free'` picks the above-divider HTML (or the whole body for
// `audience: 'free'` posts). `view: 'premium'` picks the full premium body
// and falls back to free.web when no premium variant is present (e.g.
// pure-free posts that a member happens to request). Callers are responsible
// for only requesting `premium` after authenticating an Ark+ reader — this
// function trusts that decision.
//
// The free view reaches for the flat `content_html` ONLY on a post whose
// audience is `free`. That field carries no free/premium split — it is the
// post's body, whole — so on a `premium` or `both` post it may be exactly the
// text the paywall exists to withhold, and a missing `free.web` there (Beehiiv
// omits it when nothing sits above the divider) must render as an empty
// preview rather than fall through to it. An empty body is what a gated post
// with no preview looks like; the title and excerpt still carry the card.
export function selectBeehiivWebHtml(
  p: BeehiivPost,
  view: 'free' | 'premium',
): string {
  const audience = (p.audience ?? 'free').toLowerCase()
  return view === 'premium'
    ? p.content?.premium?.web?.trim() ||
        p.content?.free?.web ||
        p.content_html ||
        ''
    : (p.content?.free?.web ??
        (audience === 'free' ? p.content_html : undefined) ??
        '')
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

  const audience = (p.audience ?? 'free').toLowerCase()
  const rawHtml = selectBeehiivWebHtml(p, view)
  const bodyHtml = sanitizeBeehiivHtml(rawHtml)
  const plain = stripHtml(rawHtml)

  // Tier = "does the members' edition carry more than the free one?", read
  // from the content rather than `audience`. One newsletter goes to everyone
  // with members-only sections for the premium tier, and Beehiiv doesn't
  // reliably reflect that in `audience`: issues sent only to the premium
  // segment come back `audience: 'free'` with a free.web that is nothing but
  // the title/byline header and the whole issue in premium.web (observed on
  // the live publication, 2026-09-23). Comparing the two bodies catches that,
  // a paywall divider, and per-tier content blocks alike.
  const freeText = stripHtml(
    p.content?.free?.web ?? (audience === 'free' ? p.content_html : '') ?? '',
  )
  const premiumText = stripHtml(p.content?.premium?.web ?? '')
  const tier: 'free' | 'ark-plus' =
    audience === 'premium' || premiumText.length > freeText.length
      ? 'ark-plus'
      : 'free'

  // Members-only = the free edition carries no issue at all, only the
  // title/byline/date header Beehiiv renders above every body (the
  // premium-segment-only sends described above). The list hides these from
  // non-members; a post with a real free edition plus members' sections stays
  // listed for everyone.
  const membersOnly =
    audience === 'premium' ||
    (tier === 'ark-plus' && freeIsHeaderOnly(freeText, p))

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
    membersOnly,
    authorName: firstAuthorName(p, authorFallback),
    beehiivPostId: p.id,
  }
}
