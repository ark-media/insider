import {
  communityBroadcasts,
  type CommunityBroadcast,
} from "../data/communityBroadcasts";
import type { NewsletterPost, NewsletterSlug } from "../data/newsletters";
import { upcomingEvents, type ArkEvent } from "../data/events";
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

/**
 * Build a deep link into the Circle app for a given event. Real implementation
 * would call Circle's deep-link endpoint, which signs the link so the app can
 * land the user directly on the event view (member or guest).
 */
export function circleEventLink(eventId: string): string {
  return `https://community.arkmedia.org/events/${eventId}`;
}

/** Universal app-open link — used by /account "Open in app" buttons. */
export const CIRCLE_OPEN_LINKS = {
  ios: "https://apps.apple.com/app/circle-communities/id1525026498",
  android:
    "https://play.google.com/store/apps/details?id=com.circle.circleapp",
  web: "https://app.arkmedia.org",
};

// Each Beehiiv-published newsletter has a paired Circle space where editorial
// mirrors the post and members carry the conversation. The newsletter web page
// surfaces a "Comment in Circle" link that deep-links here; /circle-sso wraps
// it so signed-in members land directly inside Circle.
const NEWSLETTER_CIRCLE_SPACES: Record<NewsletterSlug, string> = {
  "the-call-me-back-newsletter":
    "https://community.arkmedia.org/c/call-me-back-newsletter",
  "ark-daily": "https://community.arkmedia.org/c/ark-daily",
  "for-heavens-sake-newsletter":
    "https://community.arkmedia.org/c/for-heavens-sake-letter",
  "members-letter":
    "https://community.arkmedia.org/c/members-letter",
};

/**
 * Build the comment URL for a newsletter post. Wraps the Circle space link in
 * /circle-sso so signed-in members land directly on the discussion; guests are
 * prompted to set up a Circle account first.
 */
export function newsletterCommentUrl(slug: NewsletterSlug): string {
  const target = NEWSLETTER_CIRCLE_SPACES[slug];
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
