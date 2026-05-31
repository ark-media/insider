// Simplecast → Episode projection + HTML sanitizer. Lives outside dev-api.ts
// so the trust boundary (untrusted upstream HTML → allowlisted HTML safe for
// the client) is easy to read and easy to test in isolation.

import sanitizeHtml from 'sanitize-html'

export type ProjectedEpisode = {
  showSlug: string
  slug: string
  title: string
  publishedAt: string
  durationMinutes: number
  description: string
  showNotesHtml: string
  id: string
  /** Per-episode artwork from Simplecast. Empty string when unset. */
  imageUrl: string
}

export type ScEpisode = {
  id?: string
  slug?: string
  title?: string
  description?: string
  long_description?: string
  duration?: number
  published_at?: string
  status?: string
  is_published?: boolean
  /** Episode-level artwork. Absent until a producer uploads it. */
  image_url?: string
}

export type ScPodcast = {
  id?: string
  title?: string
  description?: string
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

// Allowlist tags Simplecast's HTML description actually emits for show notes
// (paragraphs, line breaks, basic formatting, lists, headings, links, quotes).
// Anything outside this set is dropped before we hand HTML to the client.
export function sanitizeShowNotes(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'a', 'strong', 'b', 'em', 'i',
      'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
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

// Prefer long_description (the full show notes) for the rich HTML field, but
// fall back to description when long_description is absent — some Simplecast
// podcasts only fill the short field.
export function projectScEpisode(e: ScEpisode, showSlug: string): ProjectedEpisode {
  const rawShowNotes = e.long_description ?? e.description ?? ''
  return {
    showSlug,
    id: e.id ?? '',
    slug: e.slug ?? e.id ?? '',
    title: e.title ?? '',
    publishedAt: (e.published_at ?? '').slice(0, 10),
    durationMinutes: Math.max(0, Math.round((e.duration ?? 0) / 60)),
    description: stripHtml(e.description ?? ''),
    showNotesHtml: sanitizeShowNotes(rawShowNotes),
    imageUrl: e.image_url ?? '',
  }
}

export function isPublishedEpisode(e: ScEpisode): boolean {
  return e.is_published !== false && Boolean(e.published_at) && Boolean(e.id)
}
