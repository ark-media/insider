// Newsletter preferences client. Wraps `/api/me/newsletters` — the server
// reads/writes the local Beehiiv subscription mirror and pushes changes
// through Beehiiv's v2 API.

export type NewsletterPrefs = {
  /** Gets The Current. */
  free: boolean;
  /** Holds the premium tier in Beehiiv. Read-only: the membership sets it. */
  premium: boolean;
  /** True when the signed-in reader is entitled to the members' edition. */
  canPremium: boolean;
  /**
   * Gets the AMA emails (the unlisted YouTube link for each AMA episode).
   * Independent of `free`. Ark+ only, default off. Null when unknown — not off.
   */
  ama: boolean | null;
};

/** One switch per request: the newsletter itself, or the AMA emails. */
export type NewsletterPrefsPatch = { free: boolean } | { ama: boolean };

export type FetchNewsletterPrefsResult =
  | { ok: true; prefs: NewsletterPrefs }
  | { ok: false; reason: "unauthenticated" | "unavailable" };

export async function fetchNewsletterPrefs(): Promise<FetchNewsletterPrefsResult> {
  try {
    const res = await fetch("/api/me/newsletters", {
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
  input: NewsletterPrefsPatch,
): Promise<{ ok: boolean; prefs?: NewsletterPrefs; error?: string }> {
  try {
    const res = await fetch("/api/me/newsletters", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as
      | NewsletterPrefs
      | { error?: string };
    if (!res.ok) {
      const err = (body as { error?: string }).error;
      if (err === "ama_unavailable") {
        return {
          ok: false,
          error: "AMA emails aren't available right now. Please try again later.",
        };
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
