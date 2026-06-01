// Newsletter preferences client. Wraps `/api/me/newsletters` — the server
// reads/writes the local Beehiiv subscription mirror and pushes changes
// through Beehiiv's v2 API.

import { getToken } from "./tokenStore";

export type NewsletterPrefs = {
  free: boolean;
  premium: boolean;
  /** True when the signed-in reader is entitled to the Ark+ members letter. */
  canPremium: boolean;
};

export type FetchNewsletterPrefsResult =
  | { ok: true; prefs: NewsletterPrefs }
  | { ok: false; reason: "unauthenticated" | "unavailable" };

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchNewsletterPrefs(): Promise<FetchNewsletterPrefsResult> {
  try {
    const headers = await authHeaders();
    const res = await fetch("/api/me/newsletters", {
      headers,
      credentials: "include",
    });
    if (res.status === 401) {
      return { ok: false, reason: "unauthenticated" };
    }
    if (!res.ok) {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, prefs: (await res.json()) as NewsletterPrefs };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function saveNewsletterPrefs(
  input: { free?: boolean; premium?: boolean },
): Promise<{ ok: boolean; prefs?: NewsletterPrefs; error?: string }> {
  try {
    const headers = await authHeaders();
    const res = await fetch("/api/me/newsletters", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as
      | NewsletterPrefs
      | { error?: string };
    if (!res.ok) {
      const err = (body as { error?: string }).error;
      if (err === "not_entitled") {
        return { ok: false, error: "Ark+ membership required." };
      }
      if (err === "beehiiv_update_failed") {
        return {
          ok: false,
          error: "Could not update newsletter preferences. Please try again.",
        };
      }
      return { ok: false, error: "Could not save. Please try again." };
    }
    return { ok: true, prefs: body as NewsletterPrefs };
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}
