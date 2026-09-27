import {
  newsletter,
  type NewsletterPost,
  type NewsletterSlug,
} from "../data/newsletters";
import type { NewsletterSource } from "./newsletterSources";
import {
  unsafeAssumeSanitized,
  type SanitizedHtml,
} from "../../shared/sanitized-html";

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

/**
 * One issue's Beehiiv web HTML, whole and sanitized server-side, for
 * `<NewsletterFrame>`. The server picks the edition from the session cookie,
 * exactly as the list does. `null` when there's nothing to frame or the
 * fetch fails — the page falls back to the list's `bodyHtml`.
 */
export async function fetchPostDocument(
  slug: NewsletterSlug,
  postSlug: string,
): Promise<SanitizedHtml | null> {
  try {
    const res = await fetch(
      `/api/beehiiv/post-document?newsletter=${encodeURIComponent(slug)}&post=${encodeURIComponent(postSlug)}`,
      { credentials: "include" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { html?: string | null };
    return body.html ? unsafeAssumeSanitized(body.html) : null;
  } catch {
    return null;
  }
}

export const beehiivSource: NewsletterSource = {
  listPosts: fetchPosts,
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
