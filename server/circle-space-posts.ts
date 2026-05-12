// Circle Admin API v2 space posts → NewsletterPost projection.
//
// Parallels `circle-broadcasts.ts`: broadcasts are emails sent by editors;
// space posts are member-facing community content. Both flow through the
// same NewsletterPost shape on the client so the newsletter UI doesn't have
// to care which Circle surface the content came from.
//
// The HTML sanitizer is shared — both broadcast HTML and space-post HTML
// originate from Circle's editors and need the same allowlist.

import { sanitizeBroadcastHtml, stripHtml } from './circle-broadcasts.js'
import type {
  NewsletterPost,
  NewsletterSlug,
} from '../src/data/newsletters.js'

export type CirclePost = {
  id?: number | string
  name?: string
  slug?: string
  // Circle's `body` is sometimes a plain HTML string and sometimes an object
  // with `.html` (and other variants). Accept both — extract the HTML below.
  body?: string | { html?: string; [k: string]: unknown }
  published_at?: string
  created_at?: string
  status?: string
  space_id?: number
  space_slug?: string
}

function extractBodyHtml(body: CirclePost['body']): string {
  if (!body) return ''
  if (typeof body === 'string') return body
  if (typeof body === 'object' && typeof body.html === 'string') return body.html
  return ''
}

export function isPublishedPost(p: CirclePost): boolean {
  if (p.status && p.status !== 'published') return false
  return Boolean(p.published_at ?? p.created_at)
}

export function projectSpacePost(
  p: CirclePost,
  newsletterSlug: NewsletterSlug,
  authorName: string,
  tier: 'free' | 'ark-plus',
): NewsletterPost | null {
  if (p.id === undefined || p.id === null) return null
  const publishedAt = p.published_at ?? p.created_at
  if (!publishedAt) return null

  const rawHtml = extractBodyHtml(p.body)
  const bodyHtml = sanitizeBroadcastHtml(rawHtml)
  const plain = stripHtml(rawHtml)
  const title = p.name ?? '(untitled)'

  // Prefer Circle's own post slug so our URL can mirror Circle's. Fall back
  // to an id-derived slug if the upstream record didn't carry one — Circle
  // ids are stable and URL-safe.
  const postSlug = p.slug && p.slug.trim() ? p.slug.trim() : `post-${String(p.id)}`
  const excerpt = plain.slice(0, 200)

  return {
    newsletterSlug,
    slug: postSlug,
    title,
    publishedAt: publishedAt.slice(0, 10),
    excerpt,
    body: plain,
    bodyHtml,
    tier,
    authorName,
  }
}
