import { getAttribution } from "./attribution";

export type GiftTerm = "6mo" | "1yr";

// The three sellable tiers a gift can grant (mirrors the server PricedTier).
export type GiftTier = "ark-plus" | "circle" | "bundle";

export type GiftInput = {
  giverEmail: string;
  giverName?: string;
  recipientEmail: string;
  recipientName?: string;
  tier: GiftTier;
  term: GiftTerm;
  // Presentment/charge currency; the server falls back to USD when absent or
  // unsupported. Chosen in the modal before the Session is created.
  currency?: string;
  message?: string;
};

export type CreateGiftResponse = {
  checkout_session_id: string;
  client_secret: string;
  tier: GiftTier;
  term: GiftTerm;
  currency: string;
};

// USD anchors per tier + term (D1). Page display only — the modal shows the
// localized total from the Stripe session's currency_options.
export const GIFT_PRICE_DOLLARS: Record<GiftTier, Record<GiftTerm, number>> = {
  "ark-plus": { "6mo": 48, "1yr": 80 },
  circle: { "6mo": 48, "1yr": 80 },
  bundle: { "6mo": 75, "1yr": 130 },
};

export const GIFT_TIER_LABEL: Record<GiftTier, string> = {
  "ark-plus": "Ark+",
  circle: "The Fold",
  bundle: "Bundle",
};

export const GIFT_TIER_BLURB: Record<GiftTier, string> = {
  "ark-plus": "Private, ad-free podcast feed",
  circle: "Access to the Fold",
  bundle: "The private feed plus the Fold",
};

export const GIFT_LABEL: Record<GiftTerm, string> = {
  "6mo": "6 months",
  "1yr": "1 year",
};

export async function createGiftCheckout(
  input: GiftInput,
): Promise<{ ok: true; data: CreateGiftResponse } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/gift/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        giver_email: input.giverEmail,
        giver_name: input.giverName,
        recipient_email: input.recipientEmail,
        recipient_name: input.recipientName,
        tier: input.tier,
        term: input.term,
        currency: input.currency,
        message: input.message,
        // Attribution rides onto the gift PaymentIntent's metadata the same way
        // it does for subscriptions, so `gift_purchased_confirmed` is
        // channel-attributed too (BI plan §4.1). Allowlisted server-side.
        attribution: getAttribution(),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as
      | CreateGiftResponse
      | { error?: string };
    if (!res.ok || !("client_secret" in data) || !("checkout_session_id" in data)) {
      const err = (data as { error?: string }).error ?? "Could not start gift checkout.";
      return { ok: false, error: err };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}

export type RedeemGiftResult =
  | { ok: true; applied: "membership" | "credit" | "mixed" | "extended"; expiresAt?: string }
  | { ok: false; error: string; status?: number };

// Claim a gift the recipient received by email. Requires a signed-in session
// (the server keys the grant on the recipient's Auth0 sub); the /redeem page
// gates on auth before calling this. Rides the httpOnly session cookie.
export async function redeemGift(token: string): Promise<RedeemGiftResult> {
  try {
    const res = await fetch("/api/gift/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      redeemed?: boolean;
      applied?: "membership" | "credit" | "mixed" | "extended";
      expires_at?: string;
      error?: string;
    };
    if (!res.ok || !data.redeemed) {
      return {
        ok: false,
        status: res.status,
        error: data.error ?? "Could not redeem this gift.",
      };
    }
    return {
      ok: true,
      applied: data.applied ?? "membership",
      expiresAt: data.expires_at,
    };
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}

// Claim a gift via the single-email magic link. The `mt` token (from
// /redeem?mt=…) both authenticates and identifies the gift: one call creates or
// finds the recipient's account, logs them in (sets the session cookie on the
// response), and redeems. No prior sign-in needed — that's the whole point.
export async function claimGiftWithMagicToken(mt: string): Promise<RedeemGiftResult> {
  try {
    const res = await fetch("/api/gift/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mt }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      redeemed?: boolean;
      applied?: "membership" | "credit" | "mixed" | "extended";
      expires_at?: string;
      error?: string;
    };
    if (!res.ok || !data.redeemed) {
      return {
        ok: false,
        status: res.status,
        error: data.error ?? "Could not redeem this gift.",
      };
    }
    return {
      ok: true,
      applied: data.applied ?? "membership",
      expiresAt: data.expires_at,
    };
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}

export async function fetchGiftStatus(
  checkoutSessionId: string,
  giverEmail: string,
): Promise<{ status: string; activated: boolean } | null> {
  try {
    const params = new URLSearchParams({ id: checkoutSessionId, email: giverEmail });
    const res = await fetch(`/api/gift/status?${params}`);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { status?: string; activated?: boolean }
      | null;
    if (!data || typeof data.status !== "string" || typeof data.activated !== "boolean") {
      return null;
    }
    return { status: data.status, activated: data.activated };
  } catch {
    return null;
  }
}
