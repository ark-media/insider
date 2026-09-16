// The house promo — the sale a buyer gets without knowing any code — and how
// checkout learns which code applies it.
//
// A Checkout Session can carry either a server-set `discounts` array or
// `allow_promotion_codes`, never both, and ours carry `allow_promotion_codes`
// so the buyer has a field to type into. That makes the browser responsible for
// applying the house sale too: same applyPromotionCode call, just with the code
// this endpoint returns. Stripe validates it at redemption either way, so a
// stale or tampered code buys nothing.

export type PromoInfo = {
  // The promotion code that applies this sale, e.g. "SPRING60".
  code: string;
  name: string | null;
  kind: "percent" | "amount";
  percentOff?: number;
  amountOffCents?: number;
};

type PromoQuery = {
  // A membership (plan-targeted) or a gift (any auto-apply coupon qualifies).
  plan?: "monthly" | "yearly";
  term?: "6mo" | "1yr";
  tier?: string;
  currency?: string;
};

// Null whenever there's no sale, the lookup fails, or the response is shaped
// unexpectedly — every caller treats "no promo" as full price, which is the
// safe fallback and the common case.
export async function fetchActivePromo(query: PromoQuery): Promise<PromoInfo | null> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  try {
    const res = await fetch(`/api/promo/active?${params.toString()}`);
    const data = (await res.json().catch(() => ({}))) as {
      active?: boolean;
      code?: string;
      name?: string | null;
      kind?: "percent" | "amount";
      percent_off?: number;
      amount_off_cents?: number;
    };
    if (!data.active || !data.code) return null;
    if (data.kind !== "percent" && data.kind !== "amount") return null;
    return {
      code: data.code,
      name: data.name ?? null,
      kind: data.kind,
      percentOff: data.percent_off,
      amountOffCents: data.amount_off_cents,
    };
  } catch {
    return null;
  }
}
