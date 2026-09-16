// Beehiiv → Episode projection + HTML sanitizer. Lives outside dev-api.ts
// so the trust boundary (untrusted upstream HTML → allowlisted HTML safe for
// the client) is easy to read and easy to test in isolation.

import sanitizeHtml from 'sanitize-html'
import { toIsoDate } from './lib/dates.js'

/**
 * An episode without its show notes — what the list endpoint serves.
 *
 * Notes are by far the largest field (Beehiiv's own list page runs ~250KB at
 * 50 episodes, nearly all of it notes) and only the episode page ever renders
 * them, so the list omits them entirely: an order of magnitude off the wire
 * and one `sanitize-html` pass saved per episode.
 */
export type EpisodeSummary = {
  showSlug: string
  slug: string
  title: string
  publishedAt: string
  durationMinutes: number
  description: string
  id: string
  /** Per-episode artwork from Beehiiv. Empty string when unset. */
  imageUrl: string
  /**
   * Direct audio URL. Beehiiv has no embeddable player, so this is what our
   * own player element plays. Empty string when the episode has no audio yet
   * — callers must treat it as "not playable" rather than rendering a player
   * pointed at nothing. Also empty when a paid show's audio is withheld from
   * a caller who hasn't proved membership (see server/routes/podcasts.ts).
   */
  audioUrl: string
}

/** A summary plus the sanitized show notes — what the single-episode route serves. */
export type ProjectedEpisode = EpisodeSummary & { showNotesHtml: string }

// The Beehiiv podcast episode object. Every field is optional here on purpose:
// this is the shape at the trust boundary, so the projection below is
// responsible for supplying defaults rather than the type system pretending
// upstream is well-formed.
export type BeehiivEpisode = {
  id?: string
  created?: number
  updated?: number
  title?: string
  slug?: string
  /** Unix seconds. The date Beehiiv shows publicly; our drop date. */
  displayed_date?: number
  /** Unix seconds. When it actually went out; fallback for displayed_date. */
  publish_date?: number
  description?: string
  /** Rich show notes, HTML. */
  show_notes?: string
  artwork_url?: string
  status?: 'draft' | 'scheduled' | 'published' | 'archived'
  /** Seconds. */
  duration?: number
  season_number?: number
  episode_number?: number
  audio_url?: string
  transcript_url?: string
  /** Beehiiv nests the whole show object on each episode. */
  show?: BeehiivPodcast
}

export type BeehiivPodcast = {
  id?: string
  slug?: string
  title?: string
  description?: string
  artwork_url?: string
  status?: 'draft' | 'live' | 'archived'
  author?: string
  categories?: string[]
  website_url?: string
  platform_links?: Record<string, string>
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

// Allowlist tags Beehiiv's show-notes HTML actually emits (paragraphs, line
// breaks, basic formatting, lists, headings, links, quotes). Anything outside
// this set is dropped before we hand HTML to the client.
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

export function projectBeehiivEpisodeSummary(
  e: BeehiivEpisode,
  showSlug: string,
): EpisodeSummary {
  return {
    showSlug,
    id: e.id ?? '',
    slug: e.slug ?? e.id ?? '',
    title: e.title ?? '',
    publishedAt: toIsoDate(e.displayed_date ?? e.publish_date) ?? '',
    durationMinutes: Math.max(0, Math.round((e.duration ?? 0) / 60)),
    description: stripHtml(e.description ?? ''),
    imageUrl: e.artwork_url ?? '',
    audioUrl: e.audio_url ?? '',
  }
}

// Beehiiv returns `show_notes` on both list and get. Prefer it for the rich
// HTML field, falling back to `description` for episodes where a producer only
// filled the short field. Only the single-episode route calls this — the list
// stops at the summary above rather than sanitizing 50 sets of notes nobody
// asked for.
export function projectBeehiivEpisode(
  e: BeehiivEpisode,
  showSlug: string,
): ProjectedEpisode {
  const rawShowNotes = e.show_notes ?? e.description ?? ''
  return {
    ...projectBeehiivEpisodeSummary(e, showSlug),
    showNotesHtml: sanitizeShowNotes(rawShowNotes),
  }
}

// Beehiiv models four statuses; only `published` may reach the public site.
// `status` is checked strictly (rather than "not draft") so an unrecognised
// future status fails closed instead of leaking an unpublished episode.
export function isPublishedEpisode(e: BeehiivEpisode): boolean {
  if (e.status !== 'published') return false
  if (!e.id) return false
  return Boolean(toIsoDate(e.displayed_date ?? e.publish_date))
}
