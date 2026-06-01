import {
  communityBroadcasts,
  type CommunityBroadcast,
} from "../data/communityBroadcasts";
import type { NewsletterPost, NewsletterSlug } from "../data/newsletters";
import {
  classifyLiveUpcoming,
  liveAndUpcomingEvents,
  upcomingEvents,
  type ArkEvent,
  type EventWithStatus,
} from "../data/events";
import { circleUrls, newsletterCircleSpaces } from "../config/urls";
import type { NewsletterSource } from "./newsletterSources";
import { authHeaders } from "./auth";

/**
 * Circle headless client.
 *
 * The /community subscriber feed reads `fetchEventStrip` / `fetchCommunityFeed`
 * / `fetchSuggestedSpaces`, which proxy the `/api/circle/community-*` server
 * routes (real Circle Admin v2 reads, projected to the stable client shapes)
 * and fall back to local mock data when the server has no Admin API token —
 * the same pattern the newsletter `circleSource` uses. The mock keeps local
 * dev and unit tests working without a token and preserves the v1→v2 contract:
 * only the data source behind these functions changes, never their shapes.
 */

const FAKE_LATENCY_MS = 80;

function jitter(ms = FAKE_LATENCY_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 40));
}

/**
 * GET + parse JSON, returning null ONLY on a network/parse/non-2xx failure (or
 * a missing endpoint, e.g. unit tests). A successful empty response is NOT
 * null — callers distinguish "offline → mock" from "reachable but empty → real
 * empty state". Public endpoints; no credentials so they stay edge-cacheable.
 */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Like `getJson` but attaches the member session: the Auth0 bearer (when
 * present) plus credentials so the post-checkout cookie rides along. Used for
 * member-gated endpoints (the curated feed).
 */
async function getJsonAuthed<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: await authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
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

// The feed/digest/space DTOs live in shared/ so the Node server can produce
// them without importing browser-coupled client code. Re-exported here so
// client callers keep importing them from "../lib/circle".
export type {
  ActivityDigest,
  CommunityFeedItem,
  SuggestedSpace,
} from "../../shared/community";
import type {
  ActivityDigest,
  CommunityFeedItem,
  SuggestedSpace,
} from "../../shared/community";

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
 * Re-derives each call so polling reflects an event going live. Real Circle
 * events come from `/api/circle/community-events`; falls back to mock events
 * (token-less dev / tests).
 */
export async function fetchEventStrip(): Promise<EventStripItem[]> {
  const data = await getJson<{ events?: ArkEvent[] }>(
    "/api/circle/community-events",
  );
  // null = endpoint unreachable (offline / tests) → mock; a reachable-but-empty
  // result is honored as a genuinely empty calendar.
  if (data === null) return liveAndUpcomingEvents();
  return classifyLiveUpcoming(data.events ?? [], new Date());
}

/**
 * Feed posts. v1: curated, editorially-permissioned highlights (same for every
 * subscriber) from a real Circle space via `/api/circle/community-feed`. v2:
 * the member's joined-space personalized feed. Falls back to mock highlights.
 */
export async function fetchCommunityFeed(): Promise<CommunityFeedItem[]> {
  // Member-gated endpoint → authenticated fetch. null = unreachable (offline /
  // tests) → mock; a reachable result (even empty) is honored, so the empty
  // state can render in a real deployment.
  const data = await getJsonAuthed<{ items?: CommunityFeedItem[] }>(
    "/api/circle/community-feed",
  );
  if (data !== null) return data.items ?? [];

  // Mock fallback — project preview-only fields (`body`/`visibility` never leak)
  // and land the member in the app home via SSO, since the mock posts have no
  // real Circle permalink.
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

/**
 * Spaces to suggest in the empty-state nudge. Real member-facing spaces come
 * from `/api/circle/spaces`; falls back to mock spaces. Always non-empty.
 */
export async function fetchSuggestedSpaces(): Promise<SuggestedSpace[]> {
  const data = await getJson<{ spaces?: SuggestedSpace[] }>(
    "/api/circle/spaces",
  );
  if (data !== null) return data.spaces ?? [];

  // Mock fallback (offline / tests) — each suggestion lands in the app home.
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
