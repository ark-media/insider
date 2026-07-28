// Unit tests for deriveSaveOffers — the tier/cadence → ordered-offers dispatch
// behind Flows A–E. Coupons + prices are served by a fake Stripe; amounts are
// never hardcoded in the deriver.

import { describe, test, expect } from "bun:test";
import type Stripe from "stripe";
import { SUPPORTED_CURRENCIES } from "./lib/pricing";
import { deriveSaveOffers } from "./lib/retention";
import { intentAllowedForTier } from "../shared/retention";

type CouponLike = {
  id: string;
  valid: boolean;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: "once" | "repeating";
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
  duration_in_months: 6,
  metadata: { retention_offer: "true", offer_kind: "supporter_coupon", plan: "monthly" },
});
const affordability = coupon({
  id: "aff",
  amount_off: 500,
  duration_in_months: 3,
  metadata: { retention_offer: "true", offer_kind: "affordability_coupon" },
});

describe("deriveSaveOffers", () => {
  test("cancel-ark-plus monthly → annual_switch then supporter_coupon", async () => {
    const offers = await deriveSaveOffers(fakeStripe([supporter]), "cancel-ark-plus", "monthly");
    expect(offers.map((o) => o.kind)).toEqual(["annual_switch", "supporter_coupon"]);
    // annual_switch carries the resolved prices for the savings copy.
    expect(offers[0].currentPriceCents).toBe(800);
    expect(offers[0].targetPriceCents).toBe(8000);
    expect(offers[0].couponId).toBeNull();
    // supporter coupon carried through, with the list price it discounts so the
    // card can render the design's struck-through "$8 $6/month".
    expect(offers[1].couponId).toBe("sup");
    expect(offers[1].amountOff).toBe(600);
    expect(offers[1].currentPriceCents).toBe(800);
  });

  test("cancel-ark-plus monthly still offers the annual switch when no coupon is configured", async () => {
    const offers = await deriveSaveOffers(fakeStripe([]), "cancel-ark-plus", "monthly");
    expect(offers.map((o) => o.kind)).toEqual(["annual_switch"]);
  });

  test("cancel-ark-plus yearly → monthly_switch carrying the monthly discount", async () => {
    // The switch quotes the same bounded discount the monthly card offers, so
    // moving to monthly isn't a price rise for its term.
    const offers = await deriveSaveOffers(fakeStripe([supporter]), "cancel-ark-plus", "yearly");
    expect(offers.map((o) => o.kind)).toEqual(["monthly_switch"]);
    expect(offers[0].targetPriceCents).toBe(800);
    expect(offers[0].couponId).toBe("sup");
    expect(offers[0].durationMonths).toBe(6);
  });

  test("cancel-ark-plus yearly still offers the switch when no discount is configured", async () => {
    const offers = await deriveSaveOffers(fakeStripe([]), "cancel-ark-plus", "yearly");
    expect(offers.map((o) => o.kind)).toEqual(["monthly_switch"]);
    expect(offers[0].couponId).toBeNull();
    expect(offers[0].targetPriceCents).toBe(800);
  });

  test("cancel-circle → affordability_coupon when configured", async () => {
    const offers = await deriveSaveOffers(fakeStripe([affordability]), "cancel-circle", "monthly");
    expect(offers.map((o) => o.kind)).toEqual(["affordability_coupon"]);
    expect(offers[0].durationMonths).toBe(3);
    // The Circle list price the coupon discounts, for the card's price pair.
    expect(offers[0].currentPriceCents).toBe(800);
  });

  test("neither debundle offers a card — the save is priced into the exit", async () => {
    // A debundle's alternative is "pay less, keep one product", which no card
    // can beat; the kept product lands on the debundle_intro rate instead and
    // the flow goes straight to confirm. Both directions, both cadences — and
    // staged coupons must not leak in: remove-ark-plus once reused the Ark+
    // cancel save, quoting standalone Ark+ prices to a bundle member.
    for (const intent of ["debundle-remove-ark-plus", "debundle-remove-circle"] as const) {
      for (const plan of ["monthly", "yearly"] as const) {
        expect(await deriveSaveOffers(fakeStripe([supporter, affordability]), intent, plan)).toEqual([]);
      }
    }
  });
});

describe('intentAllowedForTier — the intent is a claim, not a fact', () => {
  test('each tier can open only its own cancel/debundle flows', () => {
    expect(intentAllowedForTier('cancel-ark-plus', 'ark-plus')).toBe(true)
    expect(intentAllowedForTier('cancel-circle', 'circle')).toBe(true)
    expect(intentAllowedForTier('debundle-remove-ark-plus', 'bundle')).toBe(true)
    expect(intentAllowedForTier('debundle-remove-circle', 'bundle')).toBe(true)
  })

  test('rejects an intent for a product the member does not hold', () => {
    // The exploit: a Bundle member opening the Circle cancel flow to pull that
    // flow's coupon onto their (more expensive) bundle subscription.
    expect(intentAllowedForTier('cancel-circle', 'bundle')).toBe(false)
    expect(intentAllowedForTier('cancel-ark-plus', 'bundle')).toBe(false)
    expect(intentAllowedForTier('cancel-circle', 'ark-plus')).toBe(false)
    expect(intentAllowedForTier('cancel-ark-plus', 'circle')).toBe(false)
    expect(intentAllowedForTier('debundle-remove-ark-plus', 'ark-plus')).toBe(false)
    expect(intentAllowedForTier('debundle-remove-circle', 'circle')).toBe(false)
  })

  test('a free member can open nothing, and an unknown tier defaults closed', () => {
    expect(intentAllowedForTier('cancel-ark-plus', 'free')).toBe(false)
    expect(intentAllowedForTier('cancel-ark-plus', 'nonsense')).toBe(false)
  })
})
