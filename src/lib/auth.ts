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
  feeds: UserFeed[];
};

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function fetchMe(): Promise<Me | null> {
  try {
    const headers = await authHeaders();
    if (!headers.Authorization) return null;
    const res = await fetch("/api/me", { headers });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
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
    body: JSON.stringify({ phone, feed_id: feedId }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}
