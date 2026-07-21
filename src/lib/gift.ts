export type GiftTerm = "6mo" | "1yr";

export type GiftInput = {
  giverEmail: string;
  giverName?: string;
  recipientEmail: string;
  recipientName?: string;
  term: GiftTerm;
  message?: string;
};

export type CreateGiftResponse = {
  checkout_session_id: string;
  client_secret: string;
  term: GiftTerm;
};

export const GIFT_PRICE_DOLLARS: Record<GiftTerm, number> = {
  "6mo": 48,
  "1yr": 80,
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
        term: input.term,
        message: input.message,
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
  | { ok: true; applied: "membership" | "credit"; expiresAt?: string }
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
      applied?: "membership" | "credit";
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
