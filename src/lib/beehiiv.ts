import {
  newsletter,
  type NewsletterPost,
  type NewsletterSlug,
} from "../data/newsletters";
import type { NewsletterSource } from "./newsletterSources";

/**
 * Beehiiv client.
 *
 * Read paths (`listPosts`, `getPost`) proxy `/api/beehiiv/posts` and writes
 * (`subscribeEmail`) proxy `/api/beehiiv/subscribe`. Both call Beehiiv's v2
 * API server-side with `BEEHIIV_API_KEY` and the publication-id env var.
 */

type ApiResponse = { posts?: NewsletterPost[] };

async function fetchPosts(slug: NewsletterSlug): Promise<NewsletterPost[]> {
  try {
    // credentials:'include' attaches the session cookie when present, so the
    // server serves Ark+ members the full premium body and everyone else the
    // above-divider preview. No client-held token is involved.
    const res = await fetch(
      `/api/beehiiv/posts?newsletter=${encodeURIComponent(slug)}`,
      { credentials: "include" },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as ApiResponse;
    return body.posts ?? [];
  } catch {
    return [];
  }
}

export const beehiivSource: NewsletterSource = {
  listPosts: fetchPosts,
};

/**
 * Listing for public landing-page teasers (e.g. the homepage newsletter
 * preview). Identical to `beehiivSource.listPosts` now that auth rides the
 * cookie — a guest simply has no cookie and gets the preview.
 */
export function listPostsPublic(slug: NewsletterSlug): Promise<NewsletterPost[]> {
  return fetchPosts(slug);
}

/**
 * Subscribe an email to a newsletter via `/api/beehiiv/subscribe`, which calls
 * Beehiiv's v2 Subscriptions API server-side. Returns `ok: true` on success,
 * with a user-facing `error` string otherwise.
 */
export async function subscribeEmail(
  slug: NewsletterSlug,
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, error: "That doesn't look like a valid email." };
  }
  if (slug !== newsletter.slug) {
    return { ok: false, error: "Unknown newsletter." };
  }

  try {
    const res = await fetch("/api/beehiiv/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ newsletter: slug, email: trimmed }),
    });
    if (res.ok) return { ok: true };
    const body = (await res
      .json()
      .catch(() => ({}))) as { error?: string };
    switch (body.error) {
      case "invalid_email":
        return { ok: false, error: "That doesn't look like a valid email." };
      case "already_subscribed":
        return { ok: false, error: "Looks like you're already on the list." };
      case "too_many_requests":
        return { ok: false, error: "Too many attempts. Please wait a moment." };
      default:
        return { ok: false, error: "Could not subscribe. Please try again." };
    }
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}
