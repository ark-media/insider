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
  // Authoritative activation state, set once the server captures Supporting
  // Cast's `feed.activated` webhook.
  activated?: boolean;
  activated_at?: string | null;
  // Optimistic server-side marker: the member took a setup action but the
  // `feed.activated` webhook hasn't landed yet. The setup hub treats a feed as
  // done if it is `activated` OR `pending` (see feedIsSetUp).
  pending?: boolean;
};

// A feed counts as "set up" once it's either confirmed (the `feed.activated`
// webhook landed → `activated`) or pending (the member took a setup action and
// we recorded an optimistic server-side marker → `pending`).
export function feedIsSetUp(feed: UserFeed): boolean {
  return feed.activated === true || feed.pending === true;
}

import type { RetentionOffer } from "../../shared/retention";

// The two independent access axes: arkPlus → the private feed, circle → the
// community. Derived server-side from the tier; every gate checks an entitlement,
// never the tier (tasks/entitlement-tiers.md §2).
export type Entitlements = { arkPlus: boolean; circle: boolean };

// The SKU the member holds (billing/copy). 'free' = logged-in via Auth0 with no
// membership. Kept apart from `entitlements` — a bundle and an ark-plus member
// both have arkPlus, but they're different SKUs.
export type Tier = "ark-plus" | "circle" | "bundle" | "free";

export type Me = {
  email: string;
  tier: Tier;
  entitlements: Entitlements;
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
  // Non-2xx still carries a JSON {ok:false, error} body we can surface; only a
  // network failure or a non-JSON error page (e.g. a proxy 502) lands in the
  // catch. Without it the rejection escapes the click handler and strands the
  // page on its in-flight state.
  try {
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
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// Is the current member eligible for a retention discount on cancel, and what
// is it? Any failure — non-OK response, network error, non-JSON body —
// degrades to "no offer" so the cancel flow always proceeds (worst case: skips
// straight to the reason step).
export async function getRetentionOffer(): Promise<{
  eligible: boolean;
  offer: RetentionOffer | null;
}> {
  try {
    const res = await fetch("/api/stripe/retention-offer", {
      credentials: "include",
    });
    if (!res.ok) return { eligible: false, offer: null };
    return (await res.json()) as {
      eligible: boolean;
      offer: RetentionOffer | null;
    };
  } catch {
    return { eligible: false, offer: null };
  }
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
  try {
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
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// Undo a pending cancel: the server clears cancel_at_period_end so the
// membership renews normally again. Returns the next charge date for the
// confirmation message.
export async function reactivateSubscription(): Promise<{
  ok: boolean;
  next_charge_at?: string | null;
  error?: string;
}> {
  try {
    const res = await fetch("/api/stripe/reactivate-subscription", {
      method: "POST",
      credentials: "include",
    });
    return (await res.json()) as {
      ok: boolean;
      next_charge_at?: string | null;
      error?: string;
    };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// The signed-in member's cancel schedule, from GET /api/stripe/my-subscription.
// Drives a persistent "set to cancel" state on the billing page, so a member
// who already cancelled doesn't see the cancel option again after a reload.
// Any failure degrades to "no pending cancel" so the page still renders
// normally.
export async function getMySubscription(): Promise<{
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  pendingChange?: boolean;
}> {
  try {
    const res = await fetch("/api/stripe/my-subscription", {
      credentials: "include",
    });
    if (!res.ok) return { cancelAtPeriodEnd: false, cancelAt: null };
    return (await res.json()) as {
      cancelAtPeriodEnd: boolean;
      cancelAt: string | null;
      pendingChange?: boolean;
    };
  } catch {
    return { cancelAtPeriodEnd: false, cancelAt: null };
  }
}

// Switch tier / plan / PWYC amount on the member's existing subscription
// (task 14). Gaining an entitlement applies immediately and prorated; losing one
// lands at period end. The server derives direction and timing.
export async function changeTier(input: {
  tier: "ark-plus" | "circle" | "bundle";
  plan: "monthly" | "yearly";
  customAmountCents?: number;
}): Promise<{
  ok: boolean;
  changed?: boolean;
  timing?: "immediate" | "period_end";
  effective_at?: string;
  error?: string;
}> {
  try {
    const res = await fetch("/api/stripe/change-tier", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        tier: input.tier,
        plan: input.plan,
        custom_amount_cents: input.customAmountCents,
      }),
    });
    return (await res.json()) as {
      ok: boolean;
      changed?: boolean;
      timing?: "immediate" | "period_end";
      effective_at?: string;
      error?: string;
    };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// Persist the optimistic "these feeds are set up" marker server-side (replaces
// the old localStorage record), so it survives reloads and follows the member
// across devices while SC's `feed.activated` webhook catches up. Fire-and-
// forget: failures are swallowed because the in-memory optimistic state still
// stands and the webhook remains authoritative — a persistence blip must never
// surface an error on a setup click.
export async function persistFeedsSetUp(feedIds: number[]): Promise<void> {
  if (feedIds.length === 0) return;
  try {
    await fetch("/api/me/feeds/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ feed_ids: feedIds }),
    });
  } catch {
    /* optimistic UI stands; webhook reconciles */
  }
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
