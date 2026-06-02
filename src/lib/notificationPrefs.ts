// Content-notification preferences client. Wraps `/api/me/notifications` — the
// server reads/writes our own Neon table of per-member "email me about new
// episodes / posts" toggles. Member-only; the server returns 403 for free
// readers. Mirrors newsletterPrefs.ts (cookie-based session, no bearer).

export type NotificationPrefs = {
  episodes: boolean;
  posts: boolean;
};

export type FetchNotificationPrefsResult =
  | { ok: true; prefs: NotificationPrefs }
  | { ok: false; reason: "unauthenticated" | "not_entitled" | "unavailable" };

export async function fetchNotificationPrefs(): Promise<FetchNotificationPrefsResult> {
  try {
    const res = await fetch("/api/me/notifications", {
      credentials: "include",
    });
    if (res.status === 401) return { ok: false, reason: "unauthenticated" };
    if (res.status === 403) return { ok: false, reason: "not_entitled" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, prefs: (await res.json()) as NotificationPrefs };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function saveNotificationPrefs(
  input: { episodes?: boolean; posts?: boolean },
): Promise<{ ok: boolean; prefs?: NotificationPrefs; error?: string }> {
  try {
    const res = await fetch("/api/me/notifications", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as
      | NotificationPrefs
      | { error?: string };
    if (!res.ok) {
      return { ok: false, error: "Could not save. Please try again." };
    }
    return { ok: true, prefs: body as NotificationPrefs };
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}
