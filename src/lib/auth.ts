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

export async function fetchMe(): Promise<Me | null> {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/api/signout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    /* no-op */
  }
}

export async function cancelSubscription(): Promise<{
  ok: boolean;
  access_until?: string;
  error?: string;
}> {
  const res = await fetch("/api/stripe/cancel-subscription", {
    method: "POST",
    credentials: "same-origin",
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
  const res = await fetch("/api/sc/send-setup-sms", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, feed_id: feedId }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}
