// Unit tests for deriveSaveOffers — the tier/cadence → ordered-offers dispatch
// behind Flows A–E. Coupons + prices are served by a fake Stripe; amounts are
// never hardcoded in the deriver.

import { describe, test, expect } from "bun:test";
import type Stripe from "stripe";
import { SUPPORTED_CURRENCIES } from "./lib/pricing";
import { deriveSaveOffers } from "./lib/retention";

type CouponLike = {
  id: string;
  valid: boolean;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: "once" | "repeating" | "forever";
  duration_in_months: number | null;
  metadata: Record<string, string>;
};

const coupon = (over: Partial<CouponLike>): CouponLike => ({
  id: "c",
  valid: true,
  name: null,
  percent_off: null,
  amount_off: null,
  currency: "usd",
  duration: "repeating",
  duration_in_months: 12,
  metadata: { retention_offer: "true" },
  ...over,
});

// Fake Stripe: coupons.list returns the staged coupons; prices.list resolves the
// catalog floor (monthly 800, yearly 8000) with full currency_options.
function fakeStripe(coupons: CouponLike[]): Stripe {
  return {
    coupons: {
      list: async () => ({ data: coupons, has_more: false }),
    },
    prices: {
      list: async (args: { lookup_keys?: string[] }) => {
        const key = args.lookup_keys?.[0] ?? "";
        const base = key.includes("monthly") ? 800 : 8000;
        const currency_options: Record<string, { unit_amount: number }> = {};
        for (const cur of SUPPORTED_CURRENCIES) {
          if (cur !== "usd") currency_options[cur] = { unit_amount: base };
        }
        return {
          data: [
            { id: `price_${key}`, product: `prod_${key}`, unit_amount: base, currency: "usd", currency_options },
          ],
        };
      },
    },
  } as unknown as Stripe;
}

const supporter = coupon({
  id: "sup",
  amount_off: 600,
  metadata: { retention_offer: "true", offer_kind: "supporter_coupon", plan: "monthly" },
});
const perpetual = coupon({
  id: "perp",
  duration: "forever",
  duration_in_months: null,
  amount_off: 667,
  metadata: { retention_offer: "true", offer_kind: "perpetual_discount", plan: "monthly" },
});
const affordability = coupon({
  id: "aff",
  amount_off: 500,
  duration_in_months: 3,
  metadata: { retention_offer: "true", offer_kind: "affordability_coupon" },
});
const freeMonths = coupon({
  id: "free3",
  percent_off: 100,
  duration_in_months: 3,
  metadata: { retention_offer: "true", offer_kind: "circle_free_months" },
});

describe("deriveSaveOffers", () => {
  test("cancel-ark-plus monthly → annual_switch then supporter_coupon", async () => {
    const offers = await deriveSaveOffers(fakeStripe([supporter]), "cancel-ark-plus", "monthly");
    expect(offers.map((o) => o.kind)).toEqual(["annual_switch", "supporter_coupon"]);
    // annual_switch carries the resolved prices for the savings copy.
    expect(offers[0].currentPriceCents).toBe(800);
    expect(offers[0].targetPriceCents).toBe(8000);
    expect(offers[0].couponId).toBeNull();
    // supporter coupon carried through.
    expect(offers[1].couponId).toBe("sup");
    expect(offers[1].amountOff).toBe(600);
  });

  test("cancel-ark-plus monthly still offers the annual switch when no coupon is configured", async () => {
    const offers = await deriveSaveOffers(fakeStripe([]), "cancel-ark-plus", "monthly");
    expect(offers.map((o) => o.kind)).toEqual(["annual_switch"]);
  });

  test("cancel-ark-plus yearly → perpetual monthly_switch only when a forever coupon exists", async () => {
    const withCoupon = await deriveSaveOffers(fakeStripe([perpetual]), "cancel-ark-plus", "yearly");
    expect(withCoupon.map((o) => o.kind)).toEqual(["monthly_switch"]);
    expect(withCoupon[0].forever).toBe(true);
    expect(withCoupon[0].couponId).toBe("perp");

    const without = await deriveSaveOffers(fakeStripe([]), "cancel-ark-plus", "yearly");
    expect(without).toEqual([]);
  });

  test("cancel-circle → affordability_coupon when configured", async () => {
    const offers = await deriveSaveOffers(fakeStripe([affordability]), "cancel-circle", "monthly");
    expect(offers.map((o) => o.kind)).toEqual(["affordability_coupon"]);
    expect(offers[0].durationMonths).toBe(3);
  });

  test("debundle-remove-circle: monthly gets no offer; yearly gets 3 months free", async () => {
    const monthly = await deriveSaveOffers(fakeStripe([freeMonths]), "debundle-remove-circle", "monthly");
    expect(monthly).toEqual([]);

    const yearly = await deriveSaveOffers(fakeStripe([freeMonths]), "debundle-remove-circle", "yearly");
    expect(yearly.map((o) => o.kind)).toEqual(["circle_free_months"]);
    expect(yearly[0].couponId).toBe("free3");
  });

  test("debundle-remove-ark-plus reuses the Ark+ save (mission + cadence offer)", async () => {
    const offers = await deriveSaveOffers(fakeStripe([supporter]), "debundle-remove-ark-plus", "monthly");
    expect(offers.map((o) => o.kind)).toEqual(["annual_switch", "supporter_coupon"]);
  });
});
