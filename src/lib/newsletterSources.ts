// Newsletter source abstraction.
//
// Each newsletter slug is bound to exactly one source (Beehiiv or Circle).
// While we evaluate the two providers we want page code to be source-agnostic:
// pages call `sourceFor(slug).listPosts(...)` and don't know or care which
// backend answers. Flipping a newsletter between providers is a one-line edit
// to `sourceBySlug` below.
//
// Subscription / email-list management is intentionally NOT part of this
// surface — that lives on the Beehiiv module and stays there during the test.

import type { NewsletterPost, NewsletterSlug } from "../data/newsletters";
import { makeTTLCache } from "../../shared/ttl-cache";
import { beehiivSource } from "./beehiiv";
import { circleSpaceSource } from "./circle";

export type FetchPostResult =
  | { kind: "ok"; post: NewsletterPost }
  | { kind: "gated"; preview: NewsletterPost; reason: "ark-plus-required" }
  | { kind: "not-found" };

/**
 * A newsletter source is just a way to list posts for a given newsletter slug.
 * Single-post lookups are uniformly derivable (find-by-slug + tier gate), so
 * `getPost` is composed centrally in `sourceFor` rather than reimplemented per
 * source. This also lets us cache list results across the index → post page
 * transition: the post page reuses the same Promise the index page started.
 */
export interface NewsletterSource {
  listPosts(slug: NewsletterSlug): Promise<NewsletterPost[]>;
}

export interface ResolvedNewsletterSource extends NewsletterSource {
  getPost(
    slug: NewsletterSlug,
    postSlug: string,
    isMember: boolean,
  ): Promise<FetchPostResult>;
}

/**
 * Build a teaser preview for a gated post: keep the first two sentences from
 * the plain body, drop the rich HTML. Falls back to the excerpt when the body
 * is too short to split (typical for Beehiiv premium-only posts, which ship
 * with empty `content.free.web`). Used to render the "members-only" paywall
 * card.
 */
export function buildGatedPreview(post: NewsletterPost): NewsletterPost {
  const previewText =
    post.body.split(/(?<=\.|!|\?)\s+/).slice(0, 2).join(" ") || post.excerpt;
  return { ...post, body: previewText, bodyHtml: undefined };
}

const sourceBySlug: Record<NewsletterSlug, NewsletterSource> = {
  "the-call-me-back-newsletter": beehiivSource,
  "ark-daily": beehiivSource,
  "for-heavens-sake-newsletter": beehiivSource,
  "members-letter": circleSpaceSource,
};

// In-flight + result cache for `listPosts`. Sized to the newsletter universe,
// not requests, so it's effectively bounded. The 5-minute TTL matches the
// server-side cache header (`s-maxage=300`) — within the TTL, navigating from
// the index page to a post page reuses the same Promise instead of paying a
// second round trip just to `.find()` the post.
const NEWSLETTER_LIST_TTL_MS = 5 * 60 * 1000;
const listPostsCache = makeTTLCache<NewsletterSlug, Promise<NewsletterPost[]>>(
  NEWSLETTER_LIST_TTL_MS,
);

function cachedListPosts(
  source: NewsletterSource,
  slug: NewsletterSlug,
): Promise<NewsletterPost[]> {
  const cached = listPostsCache.get(slug);
  if (cached) return cached;
  const pending = source.listPosts(slug).catch((err) => {
    // Don't poison the cache on failure — next attempt should retry.
    listPostsCache.set(slug, Promise.resolve([]));
    throw err;
  });
  listPostsCache.set(slug, pending);
  return pending;
}

export function sourceFor(slug: NewsletterSlug): ResolvedNewsletterSource {
  const inner = sourceBySlug[slug];
  const listPosts = (s: NewsletterSlug) => cachedListPosts(inner, s);
  return {
    listPosts,
    async getPost(s, postSlug, isMember) {
      const posts = await listPosts(s);
      const post = posts.find((p) => p.slug === postSlug);
      if (!post) return { kind: "not-found" };
      if (post.tier === "free" || isMember) return { kind: "ok", post };
      return {
        kind: "gated",
        preview: buildGatedPreview(post),
        reason: "ark-plus-required",
      };
    },
  };
}
