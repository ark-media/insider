import {
  communityBroadcasts,
  type CommunityBroadcast,
} from "../data/communityBroadcasts";
import type { NewsletterPost, NewsletterSlug } from "../data/newsletters";
import { upcomingEvents, type ArkEvent } from "../data/events";
import type { FetchPostResult, NewsletterSource } from "./newsletterSources";

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

// ---------------------------------------------------------------------------
// Newsletter source — Circle Broadcasts as newsletter issues
// ---------------------------------------------------------------------------

type BroadcastsResponse = { posts?: NewsletterPost[] };

async function fetchBroadcastsFromApi(
  slug: NewsletterSlug,
): Promise<NewsletterPost[]> {
  try {
    const res = await fetch(
      `/api/circle/broadcasts?newsletter=${encodeURIComponent(slug)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as BroadcastsResponse;
    return body.posts ?? [];
  } catch {
    return [];
  }
}

async function circleListPosts(
  slug: NewsletterSlug,
): Promise<NewsletterPost[]> {
  return fetchBroadcastsFromApi(slug);
}

async function circleGetPost(
  slug: NewsletterSlug,
  postSlug: string,
  isMember: boolean,
): Promise<FetchPostResult> {
  const posts = await circleListPosts(slug);
  const post = posts.find((p) => p.slug === postSlug);
  if (!post) return { kind: "not-found" };
  // Circle broadcasts have no per-post tier — every broadcast goes to every
  // community member. A post here is only gated if the upstream projection
  // explicitly marked it ark-plus (e.g. via a Circle tag on the broadcast).
  if (post.tier === "free" || isMember) return { kind: "ok", post };

  const previewText =
    post.body.split(/(?<=\.|!|\?)\s+/).slice(0, 2).join(" ") ||
    post.excerpt;
  const preview: NewsletterPost = {
    ...post,
    body: previewText,
    // Drop the rich HTML for previews — paragraph splitting on plain text is
    // the safer surface when we're only showing a teaser.
    bodyHtml: undefined,
  };
  return { kind: "gated", preview, reason: "ark-plus-required" };
}

export const circleSource: NewsletterSource = {
  listPosts: circleListPosts,
  getPost: circleGetPost,
};
