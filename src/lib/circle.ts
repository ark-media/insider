import {
  communityBroadcasts,
  type CommunityBroadcast,
} from "../data/communityBroadcasts";
import type { NewsletterPost, NewsletterSlug } from "../data/newsletters";
import {
  classifyLiveUpcoming,
  type ArkEvent,
  type EventWithStatus,
} from "../data/events";
import { circleUrls, newsletterCircleSpaces } from "../config/urls";
import type { NewsletterSource } from "./newsletterSources";

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
 * GET + parse JSON. THROWS on a network/parse/non-2xx failure so the /community
 * UI can show an error+retry instead of silently degrading; a successful empty
 * response is a genuine empty state. Public endpoints; no credentials so they
 * stay edge-cacheable.
 */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed (${res.status})`);
  return (await res.json()) as T;
}

/**
 * Like `getJson` but attaches the member session via credentials so the
 * httpOnly session cookie rides along. Used for member-gated endpoints (the
 * curated feed). Throws on failure (see `getJson`).
 */
async function getJsonAuthed<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`${url} failed (${res.status})`);
  return (await res.json()) as T;
}

export async function fetchPublicBroadcasts(): Promise<CommunityBroadcast[]> {
  await jitter();
  return communityBroadcasts;
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
 * Live + upcoming events for the strip, classified against the current instant.
 * Re-derives each call so polling reflects an event going live. Real Circle
 * events come from `/api/circle/community-events`; throws on failure.
 */
export async function fetchEventStrip(): Promise<EventStripItem[]> {
  const data = await getJson<{ events?: ArkEvent[] }>(
    "/api/circle/community-events",
  );
  // Throws on failure (handled upstream); a reachable-but-empty result is
  // honored as a genuinely empty calendar.
  return classifyLiveUpcoming(data.events ?? [], new Date());
}

/**
 * Feed posts. v1: curated, editorially-permissioned highlights (same for every
 * subscriber) from a real Circle space via `/api/circle/community-feed`. v2:
 * the member's joined-space personalized feed. Falls back to mock highlights.
 */
export async function fetchCommunityFeed(): Promise<CommunityFeedItem[]> {
  // Member-gated endpoint → authenticated fetch. Throws on failure (handled
  // upstream); a reachable result (even empty) is honored, so the empty state
  // can render in a real deployment.
  const data = await getJsonAuthed<{ items?: CommunityFeedItem[] }>(
    "/api/circle/community-feed",
  );
  return data.items ?? [];
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
  // Throws on failure (handled upstream); a reachable-but-empty result honored.
  return data.spaces ?? [];
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
 * Build the comment URL for a newsletter post — the post's Circle space.
 * Circle owns auth (SSO against our Auth0 tenant), so a signed-in member lands
 * on the discussion and a signed-out one is bounced through Auth0 first.
 */
export function newsletterCommentUrl(slug: NewsletterSlug): string {
  return newsletterCircleSpaces[slug];
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
