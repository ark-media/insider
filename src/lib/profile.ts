// Member profile client. Wraps `/api/account/profile` — the server reads and
// writes the name on the Auth0 user, then re-mints the session cookie so the
// greeting updates without a re-login.
//
// `needsName` is the server's judgement, not `!givenName`: for most migrated
// members the stored name is one we manufactured from their email address
// ("hannah.waxman8"), which is why the client must never make this call itself.

export type Profile = {
  givenName: string | null;
  familyName: string | null;
  /** True when we hold no name the member actually gave us. */
  needsName: boolean;
};

export type FetchProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; reason: "unauthenticated" | "unavailable" };

export async function fetchProfile(): Promise<FetchProfileResult> {
  try {
    const res = await fetch("/api/account/profile", {
      credentials: "include",
    });
    if (res.status === 401) {
      return { ok: false, reason: "unauthenticated" };
    }
    if (!res.ok) {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, profile: (await res.json()) as Profile };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function saveProfile(input: {
  givenName: string;
  familyName?: string;
}): Promise<{ ok: boolean; profile?: Profile; error?: string }> {
  try {
    const res = await fetch("/api/account/profile", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        given_name: input.givenName,
        family_name: input.familyName ?? "",
      }),
    });
    const body = (await res.json().catch(() => ({}))) as
      | Profile
      | { error?: string };
    if (!res.ok) {
      const err = (body as { error?: string }).error;
      if (err === "invalid_name") {
        return { ok: false, error: "Please enter a name we can use." };
      }
      if (err === "profile_not_writable") {
        return {
          ok: false,
          error: "We couldn't update this account. Please contact support.",
        };
      }
      return { ok: false, error: "Could not save. Please try again." };
    }
    return { ok: true, profile: body as Profile };
  } catch {
    return { ok: false, error: "Could not save. Please try again." };
  }
}
