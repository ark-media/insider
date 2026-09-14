// Circle Admin API v2 → the PUBLIC /fold marketing showcase.
//
// The "You might do inside the Fold app" grid used to be six hand-written
// sample posts. It now shows real posts from the real community. That means
// this projection, unlike circle-community.ts, crosses the members-only
// boundary: its output is served ungated to logged-out visitors.
//
// So it narrows on the way out, and every narrowing below is load-bearing:
//
//   - allowlisted spaces only (SHOWCASE_SPACE_SLUGS) — never announcements,
//     onboarding, FAQs, or Introduce Yourself, which is where members put
//     personal detail they'd expect to stay inside a paid community;
//   - surname reduced to an initial ("Ava W."), matching what the cards
//     already rendered;
//   - Circle's location profile field reduced to its city.
//
// Anything added here is published to the open internet, so widen the
// allowlist only deliberately.

import { stripHtml } from './show-notes.js'
import { toIsoDate } from './lib/dates.js'
import { extractBodyHtml, type CircleFeedPost } from './circle-community.js'
import type { ShowcasePost } from '../shared/community.js'
import { circleUrls } from '../src/config/urls.js'

const CIRCLE_APP_URL = circleUrls.community

// The only spaces whose posts may appear on the public page. Slugs, matching
// the rebuilt community's three conversational rooms — the same three
// ThreeRooms markets further down /fold.
export const SHOWCASE_SPACE_SLUGS = ['conversation', 'ask-share', 'lounge'] as const

// Card text is one short paragraph; anything longer is an ellipsis away.
const EXCERPT_MAX = 160

/** The Admin v2 post fields the showcase reads, on top of the feed's. */
export type CircleShowcasePost = CircleFeedPost & {
  space_slug?: string
  user_email?: string
  user_avatar_url?: string | null
  comments_count?: number
  likes_count?: number
}

/** Circle member profile, reduced to what the card shows. */
export type ShowcaseAuthor = {
  location?: string
  avatarUrl?: string
}

/**
 * "Ava Weiner" → "Ava W.". Single-word names pass through unchanged (there is
 * no surname to withhold), and an already-initialled name ("Ava W.") is left
 * alone rather than trimmed to "Ava W..".
 */
export function publicAuthorName(fullName: string | undefined): string {
  const name = fullName?.trim().replace(/\s+/g, ' ')
  if (!name) return 'A Fold member'
  const parts = name.split(' ')
  if (parts.length === 1) return parts[0]
  const last = parts[parts.length - 1]
  const initial = last.charAt(0).toUpperCase()
  return `${parts.slice(0, -1).join(' ')} ${initial}.`
}

/**
 * Circle stores location as a full geocoded string — "New York City, New York,
 * United States". The card wants the city, the way the design's "Buenos Aires"
 * and "Toronto" read.
 */
export function cityFromLocation(location: string | undefined): string | undefined {
  const city = location?.split(',')[0]?.trim()
  return city ? city : undefined
}

export function projectShowcasePost(
  p: CircleShowcasePost,
  author: ShowcaseAuthor = {},
): ShowcasePost | null {
  if (p.id === undefined || p.id === null) return null
  if (p.status && p.status !== 'published') return null

  const roomSlug = p.space_slug?.trim()
  if (!roomSlug) return null
  // Defence in depth: the fetcher only asks for allowlisted spaces, but a
  // projection that trusted its caller is one refactor away from leaking one.
  if (!(SHOWCASE_SPACE_SLUGS as readonly string[]).includes(roomSlug)) return null

  const publishedAt = toIsoDate(p.published_at ?? p.created_at)
  if (!publishedAt) return null

  // Prefer the title — it's what the author chose to lead with. Untitled posts
  // (Circle allows them) fall back to the opening of the body.
  const title = p.name?.trim()
  const plain = stripHtml(extractBodyHtml(p.body)).trim()
  const excerpt =
    plain.length > EXCERPT_MAX ? `${plain.slice(0, EXCERPT_MAX).trimEnd()}…` : plain
  const text = title || excerpt
  // An image-only post has neither a title nor body text. Nothing to show.
  if (!text) return null

  return {
    id: String(p.id),
    authorName: publicAuthorName(p.user_name),
    authorAvatarUrl: p.user_avatar_url?.trim() || author.avatarUrl || undefined,
    authorLocation: cityFromLocation(author.location),
    roomSlug,
    roomName: p.space_name?.trim() || roomSlug,
    text,
    replyCount: Math.max(0, p.comments_count ?? 0),
    likeCount: Math.max(0, p.likes_count ?? 0),
    publishedAt,
    href: p.url || CIRCLE_APP_URL,
  }
}

/**
 * Pick the posts the grid shows.
 *
 * Selection is capped per room so one busy room can't take all six cards and
 * make a three-room community look like a one-room one; the cap is relaxed
 * (newest first) only when the rooms between them can't otherwise fill the
 * grid. Whatever that settles on is then returned in plain recency order —
 * the cap shapes *which* posts appear, never the order they read in.
 */
export function selectShowcasePosts(
  posts: ShowcasePost[],
  limit: number,
  perRoomCap: number,
): ShowcasePost[] {
  // Newest first, ties broken by id descending — Circle ids climb, so within a
  // single day the later post still sorts first.
  const byRecency = (a: ShowcasePost, b: ShowcasePost) =>
    b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id)

  const newestFirst = [...posts].sort(byRecency)

  const picked: ShowcasePost[] = []
  const takenIds = new Set<string>()
  const perRoom = new Map<string, number>()

  for (const p of newestFirst) {
    if (picked.length >= limit) break
    const taken = perRoom.get(p.roomSlug) ?? 0
    if (taken >= perRoomCap) continue
    perRoom.set(p.roomSlug, taken + 1)
    takenIds.add(p.id)
    picked.push(p)
  }

  for (const p of newestFirst) {
    if (picked.length >= limit) break
    if (takenIds.has(p.id)) continue
    picked.push(p)
  }

  return picked.sort(byRecency)
}
