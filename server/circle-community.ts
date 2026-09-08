// Circle Admin API v2 → /community subscriber-feed projections.
//
// Parallels circle-broadcasts.ts / circle-space-posts.ts, but feeds the
// signed-in Ark+ subscriber view on /community rather than the newsletter
// pages. Three surfaces, three projections, all returning the v1→v2-stable
// client shapes so the data source can swap (admin reads now → per-member
// reads later) without touching the UI:
//
//   events      → ArkEvent[]            (live/upcoming strip)
//   space posts → CommunityFeedItem[]   (curated highlights feed)
//   spaces      → SuggestedSpace[]      (empty-state nudge)
//
// Deep links point straight at the member-facing Circle URL. Circle owns auth:
// it's configured for SSO against our Auth0 tenant (the `/oauth2/initiate` →
// `auth.ark-plus.xyz` chain), so an unauthenticated click is bounced through
// Auth0 and lands on the destination. (The old `/circle-sso` JWT bridge pointed
// at a non-existent Circle `/sso` endpoint and 404'd — removed.)

import { stripHtml } from './show-notes.js'
import { toIsoDate } from './lib/dates.js'
import type { ArkEvent, EventFormat } from '../src/data/events.js'
import type { CommunityFeedItem, SuggestedSpace } from '../shared/community.js'
import { circleUrls } from '../src/config/urls.js'

// Fallback Circle destination when a record carries no canonical url. Read from
// the one place the community's host lives — a second copy here is how the
// server kept pointing at a hostname the community had already moved off.
const CIRCLE_APP_URL = circleUrls.community

// ---------------------------------------------------------------------------
// Events  →  ArkEvent
// ---------------------------------------------------------------------------

export type CircleEvent = {
  id?: number | string
  name?: string
  slug?: string
  // Full ISO instant (e.g. 2026-05-12T23:00:00.000Z) — kept as-is, never
  // date-truncated, since live/upcoming classification needs the time.
  starts_at?: string
  duration_in_seconds?: number
  location_type?: string
  in_person_location?: string | null
  host?: string | null
  member_name?: string | null
  url?: string
}

// Circle's location_type doesn't map cleanly onto our EventFormat union, so we
// pick the closest format for type-safety and carry a human label for display.
const EVENT_FORMAT_LABEL: Record<string, string> = {
  live_room: 'Live room',
  in_person: 'In person',
  tbd: 'Event',
}

function eventFormat(locationType?: string): EventFormat {
  if (locationType === 'in_person') return 'in-person'
  if (locationType === 'live_room') return 'audio-room'
  return 'video-ama'
}

export function projectEvent(e: CircleEvent): ArkEvent | null {
  if (e.id === undefined || e.id === null) return null
  const startsAt = e.starts_at?.trim()
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) return null

  const loc = e.location_type ?? undefined
  const id = e.slug?.trim() ? e.slug.trim() : `event-${String(e.id)}`
  const venue = e.in_person_location?.trim() || undefined

  return {
    id,
    title: e.name?.trim() || 'Untitled event',
    startsAt,
    durationMinutes: e.duration_in_seconds
      ? Math.max(1, Math.round(e.duration_in_seconds / 60))
      : 60,
    format: eventFormat(loc),
    formatLabel: loc ? (EVENT_FORMAT_LABEL[loc] ?? 'Event') : undefined,
    access: 'ark-plus',
    hosts: [e.host?.trim() || e.member_name?.trim() || 'Ark Media'],
    description: '',
    location: loc === 'in_person' ? 'in-person' : 'circle-app',
    venue,
    deepLink: e.url || undefined,
  }
}

// ---------------------------------------------------------------------------
// Space posts  →  CommunityFeedItem  (curated highlights)
// ---------------------------------------------------------------------------

export type CircleFeedPost = {
  id?: number | string
  name?: string
  slug?: string
  body?: string | { body?: string; html?: string; [k: string]: unknown }
  published_at?: string
  created_at?: string
  status?: string
  user_name?: string
  space_name?: string
  url?: string
}

function extractBodyHtml(body: CircleFeedPost['body']): string {
  if (!body) return ''
  if (typeof body === 'string') return body
  if (typeof body.body === 'string') return body.body
  if (typeof body.html === 'string') return body.html
  return ''
}

export function isPublishedFeedPost(p: CircleFeedPost): boolean {
  if (p.status && p.status !== 'published') return false
  return Boolean(p.published_at ?? p.created_at)
}

export function projectFeedPost(p: CircleFeedPost): CommunityFeedItem | null {
  if (p.id === undefined || p.id === null) return null
  const publishedAt = toIsoDate(p.published_at ?? p.created_at)
  if (!publishedAt) return null

  const title = p.name?.trim() || undefined
  const plain = stripHtml(extractBodyHtml(p.body))
  const excerpt =
    plain.length > 200 ? `${plain.slice(0, 200).trimEnd()}…` : plain
  // Read-only teaser: drop posts with no title and no body — nothing to show.
  if (!title && !excerpt) return null

  return {
    id: String(p.id),
    title,
    authorName: p.user_name?.trim() || 'Ark Media',
    authorRole: p.space_name?.trim() || 'Community',
    publishedAt,
    excerpt,
    href: p.url || CIRCLE_APP_URL,
  }
}

// ---------------------------------------------------------------------------
// Spaces  →  SuggestedSpace  (empty-state nudge)
// ---------------------------------------------------------------------------

export type CircleSpace = {
  id?: number
  slug?: string
  name?: string
  space_type?: string
  url?: string
}

// System / non-joinable spaces excluded from the "join a space" nudge.
const SYSTEM_SPACE_SLUGS = new Set([
  'events-71d23b',
  'ark-code-of-conduct',
  'start-here',
  'introduce-yourself',
])

export function projectSpaces(records: CircleSpace[]): SuggestedSpace[] {
  const out: SuggestedSpace[] = []
  for (const s of records) {
    const slug = s.slug?.trim()
    if (!slug) continue
    if (SYSTEM_SPACE_SLUGS.has(slug)) continue
    if (s.space_type === 'event') continue
    out.push({
      id: slug,
      name: s.name?.trim() || slug,
      href: s.url?.trim() || `${CIRCLE_APP_URL}/c/${slug}`,
    })
  }
  return out
}
