import {
  communityBroadcasts,
  type CommunityBroadcast,
} from "../data/communityBroadcasts";
import type { NewsletterPost, NewsletterSlug } from "../data/newsletters";
import {
  liveAndUpcomingEvents,
  upcomingEvents,
  type ArkEvent,
  type EventWithStatus,
} from "../data/events";
import { circleUrls, newsletterCircleSpaces } from "../config/urls";
import type { NewsletterSource } from "./newsletterSources";

/**
 * Mock Circle headless client.
 *
 * Real implementation would call Circle's admin API with a server-side token
 * (BCommunity SSO + headless reads). Each function here returns the same shape
 * the real API would, after light projection — so the UI is stable when we
 * swap to a real fetcher.
 *
 * Two surfaces share this module:
 *   1. The /community page reads `fetchPublicBroadcasts` / `fetchUpcomingEvents`
 *      to render Ark+-gated community content.
 *   2. The newsletter pages read `circleSource` (a `NewsletterSource`) for
 *      newsletters bound to Circle Broadcasts during the Beehiiv vs Circle
 *      evaluation. `circleSource` proxies `/api/circle/broadcasts` and falls
 *      back to mock newsletter posts when the server has no Admin API token.
 */

const FAKE_LATENCY_MS = 80;

function jitter(ms = FAKE_LATENCY_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 40));
}

export async function fetchPublicBroadcasts(): Promise<CommunityBroadcast[]> {
  await jitter();
  return communityBroadcasts;
}

export async function fetchUpcomingEvents(): Promise<ArkEvent[]> {
  await jitter();
  return upcomingEvents();
}

// ---------------------------------------------------------------------------
// Subscriber community feed (v1)
//
// These power the signed-in Ark+ subscriber's /community feed. Their return
// shapes are the v1→v2 contract: v1 projects the admin/mock data path below;
// v2 swaps the backing source to authenticated per-member Circle reads without
// changing these types or the UI that consumes them. The UI only ever sees
// these projections — never the raw `CommunityBroadcast` shape.
// ---------------------------------------------------------------------------

/** A read-only feed teaser. Every action on it deep-links into the app. */
export type CommunityFeedItem = {
  id: string;
  authorName: string;
  authorRole: string;
  /** ISO date */
  publishedAt: string;
  /** Preview text only — the full body stays in the app. */
  excerpt: string;
  /** Deep link that lands the member on this discussion in the app. */
  href: string;
};

/**
 * Per-member "since you were last here" digest. v1 always returns null — true
 * unread/reply counts need authenticated per-member reads (v2). The UI hides
 * the digest entirely while this is null.
 */
export type ActivityDigest = {
  /** ISO timestamp of the baseline this digest is measured from. */
  since: string;
  newPosts: number;
  replies: number;
  mentions: number;
};

/** A space to suggest in the empty/quiet-feed onboarding nudge. */
export type SuggestedSpace = {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  /** Deep link that lands the member in this space in the app. */
  href: string;
};

/** A live/upcoming event for the strip, with its derived status. */
export type EventStripItem = EventWithStatus;

/**
 * Wrap a Circle destination in the /circle-sso bridge so a signed-in member
 * lands directly on it (guests are sent to set up Circle first). Mirrors
 * `newsletterCommentUrl`.
 */
function circleSsoLink(returnTo: string): string {
  return `/circle-sso?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * Mock "most active" spaces for the empty-state nudge. In v2 this is replaced
 * by the member's join-eligible spaces from Circle; the projection below keeps
 * `SuggestedSpace` stable across that swap.
 */
const MOCK_SPACES: ReadonlyArray<Omit<SuggestedSpace, "href">> = [
  {
    id: "call-me-back",
    name: "Inside Call Me Back",
    description:
      "The room around the flagship show — daily threads on the news Dan and Amit are tracking.",
    memberCount: 4120,
  },
  {
    id: "for-heavens-sake",
    name: "For Heaven's Sake",
    description:
      "Members picking up where Donniel and Yossi leave off, between episodes.",
    memberCount: 1870,
  },
  {
    id: "meetups",
    name: "City meetups",
    description:
      "Members organizing in-person coffees and watch parties, city by city.",
    memberCount: 920,
  },
];

/**
 * Live + upcoming events for the strip, classified against the current instant.
 * Re-derives each call so polling reflects an event going live.
 */
export async function fetchEventStrip(): Promise<EventStripItem[]> {
  await jitter();
  return liveAndUpcomingEvents();
}

/**
 * Feed posts. v1: curated, editorially-permissioned highlights (same for every
 * subscriber). v2: the member's joined-space personalized feed.
 */
export async function fetchCommunityFeed(): Promise<CommunityFeedItem[]> {
  await jitter();
  // Project preview-only fields — `body` and `visibility` never leak to the UI.
  // v1 has no real per-post Circle URLs (those are opaque hash-suffixed slugs),
  // so every teaser lands the member in the community app home via SSO; v2's
  // per-member reads will carry the real post permalink.
  return communityBroadcasts.map((b: CommunityBroadcast) => ({
    id: b.id,
    authorName: b.authorName,
    authorRole: b.authorRole,
    publishedAt: b.publishedAt,
    excerpt: b.excerpt,
    href: circleSsoLink(circleUrls.community),
  }));
}

/**
 * Per-member activity digest. v1 returns null (no per-member reads yet); v2
 * returns real unread/reply/mention counts.
 */
export async function fetchActivityDigest(): Promise<ActivityDigest | null> {
  await jitter();
  return null;
}

/** Spaces to suggest in the empty-state nudge. Always non-empty. */
export async function fetchSuggestedSpaces(): Promise<SuggestedSpace[]> {
  await jitter();
  // v1 has no real per-space slugs for these mock spaces (Circle's are opaque,
  // e.g. /c/events-71d23b), so each suggestion lands the member in the app home
  // via SSO; v2's per-member reads will carry the real space URL.
  return MOCK_SPACES.map((s) => ({
    ...s,
    href: circleSsoLink(circleUrls.community),
  }));
}

/**
 * Deep link to the events space in the Community app, where every event lives.
 * Circle's per-event URLs are opaque, hash-suffixed slugs that aren't derivable
 * from our event ids, so v1 lands the member on the events space rather than a
 * fabricated permalink. The real implementation will call Circle's deep-link
 * endpoint for a signed per-event URL.
 */
export function circleEventLink(): string {
  return circleUrls.eventsSpace;
}

/** Universal app-open link — used by /account "Open in app" buttons. */
export const CIRCLE_OPEN_LINKS = {
  ios: circleUrls.appStoreIos,
  android: circleUrls.appStoreAndroid,
  web: circleUrls.webApp,
};

/**
 * Build the comment URL for a newsletter post. Wraps the Circle space link in
 * /circle-sso so signed-in members land directly on the discussion; guests are
 * prompted to set up a Circle account first.
 */
export function newsletterCommentUrl(slug: NewsletterSlug): string {
  const target = newsletterCircleSpaces[slug];
  return `/circle-sso?return_to=${encodeURIComponent(target)}`;
}

// ---------------------------------------------------------------------------
// Newsletter sources — Circle Broadcasts and Circle space posts
//
// Both endpoints answer with the same `{ posts: NewsletterPost[] }` shape, so
// one fetcher serves both. The only thing that varies is which endpoint to
// hit; gating semantics are identical (free unless the upstream projection
// already marked it ark-plus).
// ---------------------------------------------------------------------------

type PostsResponse = { posts?: NewsletterPost[] };

async function fetchCirclePosts(
  endpoint: "broadcasts" | "space-posts",
  slug: NewsletterSlug,
): Promise<NewsletterPost[]> {
  try {
    const res = await fetch(
      `/api/circle/${endpoint}?newsletter=${encodeURIComponent(slug)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as PostsResponse;
    return body.posts ?? [];
  } catch {
    return [];
  }
}

export const circleSource: NewsletterSource = {
  listPosts: (slug) => fetchCirclePosts("broadcasts", slug),
};
export const circleSpaceSource: NewsletterSource = {
  listPosts: (slug) => fetchCirclePosts("space-posts", slug),
};
