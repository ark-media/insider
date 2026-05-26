import {
  newsletters,
  type Newsletter,
  type NewsletterPost,
  type NewsletterSlug,
} from "../data/newsletters";
import type { NewsletterSource } from "./newsletterSources";
import { getToken } from "./tokenStore";

/**
 * Beehiiv client.
 *
 * Read paths (`listPosts`, `getPost`) proxy `/api/beehiiv/posts` and writes
 * (`subscribeEmail`) proxy `/api/beehiiv/subscribe`. Both call Beehiiv's v2
 * API server-side with `BEEHIIV_API_KEY` and per-newsletter publication-id
 * env vars.
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
    // Attach the Auth0 bearer when present so the server can read the
    // reader's tier claim and serve the full premium body to Ark+ members.
    // Without it, the server falls back to the above-divider preview.
    const token = await getToken();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    const res = await fetch(
      `/api/beehiiv/posts?newsletter=${encodeURIComponent(slug)}`,
      { headers, credentials: "same-origin" },
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
  if (!newsletters.find((n) => n.slug === slug)) {
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
