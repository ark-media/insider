import { useAsyncResource, type AsyncResource } from "./useAsyncResource";
import { TIERS } from "../data/pricingTiers";
import type { TierAmounts } from "./currency";

export type Pricing = {
  tiers: Record<string, TierAmounts>;
  /** Geo-detected presentment currency for display — checkout owns the choice. */
  currency: string;
  /** Minor-unit factor for `currency` (100 for USD, 1 for JPY). */
  factor: number;
};

// A resolved response is cached for the life of the page: prices don't move
// mid-session, and every pricing surface reads them, so the card grid and the
// comparison table share one request and can't end up showing two different
// currencies. A failure clears the cache — which is what lets `retry()` refetch.
let inFlight: Promise<Pricing> | null = null;

async function fetchPricing(): Promise<Pricing> {
  const res = await fetch("/api/pricing");
  if (!res.ok) throw new Error("pricing request failed");
  const data = (await res.json().catch(() => ({}))) as {
    tiers?: Record<string, TierAmounts>;
    default_currency?: string;
    minor_factors?: Record<string, number>;
  };
  const tiers = data.tiers;
  if (
    !tiers ||
    !TIERS.every(
      (t) =>
        typeof tiers[t.key]?.monthly_cents === "number" &&
        typeof tiers[t.key]?.yearly_cents === "number",
    )
  ) {
    throw new Error("pricing response malformed");
  }
  // USD fallback when the platform geo header is absent.
  const currency = data.default_currency ?? "usd";
  const factor = data.minor_factors?.[currency] ?? 100;
  return { tiers, currency, factor };
}

/**
 * Floor prices from Stripe (the source of truth) via /api/pricing — never
 * hardcoded, so a displayed amount can't drift from what we actually charge.
 */
export function usePricing(): AsyncResource<Pricing> {
  return useAsyncResource(() => {
    if (!inFlight) {
      inFlight = fetchPricing().catch((err) => {
        inFlight = null;
        throw err;
      });
    }
    return inFlight;
  }, []);
}

// The annual discount as a whole percent, or null when there's nothing to
// advertise. The ratio is currency-invariant, so it's computed off the USD
// amounts (always present in the response).
export function annualSavingsPct(amounts: TierAmounts): number | null {
  const pct = Math.round(
    (1 - amounts.yearly_cents / (amounts.monthly_cents * 12)) * 100,
  );
  return pct > 0 ? pct : null;
}
