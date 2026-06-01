import { getToken } from "./tokenStore";

export type FeedApp = {
  app: string;
  name: string;
  url: string;
};

export type UserFeed = {
  id: number;
  name: string;
  url: string;
  description?: string;
  image_url?: string;
  apps?: FeedApp[];
};

export type Me = {
  email: string;
  // 'ark-plus-member' = paid (has Simplecast record). 'free' = logged-in via
  // Auth0 with no SC record. Always present on the server response.
  tier: "ark-plus-member" | "free";
  feeds: UserFeed[];
};

// Authenticated requests accept either source of session:
//   - Auth0 access token → Authorization: Bearer header
//   - Checkout-session token → httpOnly cookie attached by credentials:'include'
// We always include credentials so the cookie attaches when present, and add
// the Bearer header when getToken() returns one.
//
// Pass `accessToken` from getAccessTokenSilently when calling before the token
// getter is registered (e.g. SubscriberAuthProvider.refresh).
export async function authHeaders(opts?: {
  accessToken?: string | null;
}): Promise<Record<string, string>> {
  const token =
    opts && "accessToken" in opts
      ? (opts.accessToken ?? null)
      : await getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

// Resolves to `null` for a genuine guest (401 — no valid session) and to a `Me`
// for a signed-in member. A network failure or non-401 server error THROWS, so
// the auth provider can distinguish "logged out" from "couldn't reach the
// server" and surface an error+retry instead of silently demoting to guest.
export async function fetchMe(opts?: {
  accessToken?: string | null;
}): Promise<Me | null> {
  const headers = await authHeaders(opts);
  const res = await fetch("/api/me", {
    headers,
    credentials: "include",
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me failed (${res.status})`);
  return (await res.json()) as Me;
}

export async function cancelSubscription(): Promise<{
  ok: boolean;
  access_until?: string;
  error?: string;
}> {
  const headers = await authHeaders();
  const res = await fetch("/api/stripe/cancel-subscription", {
    method: "POST",
    headers,
    credentials: "include",
  });
  return (await res.json()) as {
    ok: boolean;
    access_until?: string;
    error?: string;
  };
}

export async function sendSetupSms(
  phone: string,
  feedId?: number,
): Promise<{ ok: boolean; error?: string }> {
  const headers = await authHeaders();
  const res = await fetch("/api/sc/send-setup-sms", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    credentials: "include",
    body: JSON.stringify({ phone, feed_id: feedId }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}
