import {
  newsletters,
  type Newsletter,
  type NewsletterPost,
  type NewsletterSlug,
} from "../data/newsletters";
import type { NewsletterSource } from "./newsletterSources";

/**
 * Beehiiv client.
 *
 * Read paths (`listPosts`, `getPost`) proxy `/api/beehiiv/posts`, which calls
 * Beehiiv's v2 API server-side with `BEEHIIV_API_KEY` and per-newsletter
 * publication-id env vars. The server returns an empty list when those are
 * unset — there is no client-side mock fallback.
 *
 * Subscription writes (`subscribeEmail`) remain mocked for now: Beehiiv stays
 * as the email-delivery layer during the Circle evaluation but the write path
 * isn't part of the read-side comparison.
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

type ApiResponse = { posts?: NewsletterPost[] };

async function fetchPostsFromApi(
  slug: NewsletterSlug,
): Promise<NewsletterPost[]> {
  try {
    const res = await fetch(
      `/api/beehiiv/posts?newsletter=${encodeURIComponent(slug)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as ApiResponse;
    return body.posts ?? [];
  } catch {
    return [];
  }
}

export const beehiivSource: NewsletterSource = {
  listPosts: fetchPostsFromApi,
};

/**
 * Subscribe an email to a newsletter. Mocked — real impl would call beehiiv's
 * Subscriptions API. Resolves immediately with `ok: true` for any well-formed
 * email. Used for every newsletter regardless of read source, since Beehiiv
 * stays as the email-delivery layer during the Circle test.
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
