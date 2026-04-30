import {
  newsletters,
  newsletterPosts,
  type Newsletter,
  type NewsletterPost,
  type NewsletterSlug,
} from "../data/newsletters";

/**
 * Mock beehiiv API client.
 *
 * Real implementation would call beehiiv's Publications + Posts APIs with an
 * API key. Paid posts (`tier: "ark-plus"`) come back with full content over
 * the wire only for entitled users; on the public site we render preview +
 * paywall.
 */

const FAKE_LATENCY_MS = 60;

function jitter(ms = FAKE_LATENCY_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 40));
}

export async function listPublications(): Promise<Newsletter[]> {
  await jitter();
  return newsletters;
}

export async function getPublication(
  slug: NewsletterSlug,
): Promise<Newsletter | null> {
  await jitter();
  return newsletters.find((n) => n.slug === slug) ?? null;
}

export async function listPosts(
  slug: NewsletterSlug,
): Promise<NewsletterPost[]> {
  await jitter();
  return newsletterPosts
    .filter((p) => p.newsletterSlug === slug)
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() -
        new Date(a.publishedAt).getTime(),
    );
}

export type FetchPostResult =
  | { kind: "ok"; post: NewsletterPost }
  | { kind: "gated"; preview: NewsletterPost; reason: "ark-plus-required" }
  | { kind: "not-found" };

/**
 * Returns the post body if it's free or the caller is entitled, otherwise a
 * truncated preview alongside a gated marker.
 */
export async function getPost(
  newsletterSlug: NewsletterSlug,
  postSlug: string,
  isMember: boolean,
): Promise<FetchPostResult> {
  await jitter();
  const post = newsletterPosts.find(
    (p) => p.newsletterSlug === newsletterSlug && p.slug === postSlug,
  );
  if (!post) return { kind: "not-found" };
  if (post.tier === "free" || isMember) return { kind: "ok", post };

  const preview: NewsletterPost = {
    ...post,
    body: post.body.split(/(?<=\.|!|\?)\s+/).slice(0, 2).join(" "),
  };
  return { kind: "gated", preview, reason: "ark-plus-required" };
}

/**
 * Subscribe an email to a newsletter. Mocked — real impl would call beehiiv's
 * Subscriptions API. Resolves immediately with `ok: true` for any well-formed
 * email.
 */
export async function subscribeEmail(
  slug: NewsletterSlug,
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  await jitter(180);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "That doesn't look like a valid email." };
  }
  if (!newsletters.find((n) => n.slug === slug)) {
    return { ok: false, error: "Unknown newsletter." };
  }
  return { ok: true };
}
