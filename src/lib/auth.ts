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

import type { RetentionOffer } from "../../shared/retention";

export type Me = {
  email: string;
  // 'ark-plus-member' = paid (has Simplecast record). 'free' = logged-in via
  // Auth0 with no SC record. Always present on the server response.
  tier: "ark-plus-member" | "free";
  feeds: UserFeed[];
};

// Every authenticated request rides the httpOnly session cookie (`ark_session`
// or `ark_checkout`), attached by credentials:'include'. There is no client-
// held token — the browser never sees one.

// Resolves to `null` for a genuine guest (401 — no valid session) and to a `Me`
// for a signed-in member. A network failure or non-401 server error THROWS, so
// the auth provider can distinguish "logged out" from "couldn't reach the
// server" and surface an error+retry instead of silently demoting to guest.
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me failed (${res.status})`);
  return (await res.json()) as Me;
}

export async function cancelSubscription(input: {
  // A reason slug from shared/cancellation.ts (required, validated server-side
  // too). `note` is the optional free-text. `offerOutcome` records whether a
  // retention offer was shown first; defaults to 'not_offered'.
  reason: string;
  note?: string;
  offerOutcome?: "declined" | "not_offered";
}): Promise<{
  ok: boolean;
  access_until?: string;
  error?: string;
}> {
  const res = await fetch("/api/stripe/cancel-subscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      reason: input.reason,
      note: input.note,
      offer_outcome: input.offerOutcome ?? "not_offered",
    }),
  });
  return (await res.json()) as {
    ok: boolean;
    access_until?: string;
    error?: string;
  };
}

// Is the current member eligible for a retention discount on cancel, and what
// is it? A non-OK response degrades to "no offer" so the cancel flow always
// proceeds (worst case: skips straight to the reason step).
export async function getRetentionOffer(): Promise<{
  eligible: boolean;
  offer: RetentionOffer | null;
}> {
  const res = await fetch("/api/stripe/retention-offer", {
    credentials: "include",
  });
  if (!res.ok) return { eligible: false, offer: null };
  return (await res.json()) as { eligible: boolean; offer: RetentionOffer | null };
}

// Accept the offer: the server re-derives the coupon, attaches it to the live
// subscription, and clears any pending cancel. Returns the applied discount +
// next charge date for the confirmation.
export async function acceptRetentionOffer(): Promise<{
  ok: boolean;
  percentOff?: number | null;
  amountOff?: number | null;
  durationMonths?: number | null;
  next_charge_at?: string;
  error?: string;
}> {
  const res = await fetch("/api/stripe/accept-retention-offer", {
    method: "POST",
    credentials: "include",
  });
  return (await res.json()) as {
    ok: boolean;
    percentOff?: number | null;
    amountOff?: number | null;
    durationMonths?: number | null;
    next_charge_at?: string;
    error?: string;
  };
}

export async function sendSetupSms(
  phone: string,
  feedId?: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/sc/send-setup-sms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ phone, feed_id: feedId }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}
