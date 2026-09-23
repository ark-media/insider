// Tests for the debundle price copy. These assert promises about money, so the
// cadence distinction is the point: one 6-month coupon reads as "6 months" to a
// monthly member and "your first year" to an annual one, because that is what
// Stripe actually charges each of them.

import { describe, test, expect } from "bun:test";
import { continuationCopy, introTerm, priceIn } from "./debundleCopy";
import type { DebundlePrice } from "../../shared/retention";

// $8/mo standalone → $6.50/mo intro (half the $13 bundle), 6-month coupon.
const monthly: DebundlePrice = {
  tier: "circle",
  plan: "monthly",
  currency: "usd",
  minorFactor: 100,
  priceCents: 800,
  introCents: 650,
  introMonths: 6,
};

// $80/yr standalone → $65/yr intro (half the $130 bundle), same 6-month coupon.
const yearly: DebundlePrice = {
  tier: "circle",
  plan: "yearly",
  currency: "usd",
  minorFactor: 100,
  priceCents: 8000,
  introCents: 6500,
  introMonths: 6,
};

const noIntro: DebundlePrice = {
  tier: "ark-plus",
  plan: "monthly",
  currency: "usd",
  minorFactor: 100,
  priceCents: 800,
  introCents: null,
  introMonths: null,
};

describe("introTerm", () => {
  test("a monthly member is told the month count", () => {
    expect(introTerm(monthly, "monthly")).toBe("for 6 months");
    expect(introTerm({ ...monthly, introMonths: 1 }, "monthly")).toBe("for 1 month");
  });

  test("an annual member is told whole years — a 6-month coupon covers their one invoice", () => {
    expect(introTerm(yearly, "yearly")).toBe("for your first year");
    expect(introTerm({ ...yearly, introMonths: 12 }, "yearly")).toBe("for your first year");
    expect(introTerm({ ...yearly, introMonths: 24 }, "yearly")).toBe("for your first 2 years");
  });

  test("is empty when there is no bounded intro", () => {
    expect(introTerm(noIntro, "monthly")).toBe("");
  });
});

describe("continuationCopy", () => {
  test("quotes the intro rate, its term, and the price it reverts to", () => {
    const s = continuationCopy(monthly, "monthly", "The Fold");
    expect(s).toBe(
      "The Fold continues on its own at $6.50/month for 6 months, then $8/month — starting at the end of your current billing period.",
    );
  });

  test("quotes an annual member in years, never in months", () => {
    const s = continuationCopy(yearly, "yearly", "Ark+");
    expect(s).toContain("$65/year for your first year, then $80/year");
    expect(s).not.toContain("month");
  });

  test("states the plain price when no intro is configured", () => {
    const s = continuationCopy(noIntro, "monthly", "Ark+");
    expect(s).toBe(
      "Ark+ continues on its own at $8/month, starting at the end of your current billing period.",
    );
    expect(s).not.toContain("then");
  });

  test("degrades to price-free wording rather than blocking the member", () => {
    // The catalog didn't resolve (a Stripe hiccup). The debundle must still be
    // completable — it just can't name a figure.
    expect(continuationCopy(null, "monthly", "Ark+")).toBe(
      "Ark+ continues on its own at its standalone price, starting at the end of your current billing period.",
    );
  });

  test("a null cadence falls back to monthly wording", () => {
    expect(continuationCopy(monthly, null, "The Fold")).toContain("$6.50/month");
  });
});

describe("priceIn", () => {
  test("renders catalog cents as dollars, dropping trailing zeros site-wide", () => {
    const m = { currency: "usd", minorFactor: 100 };
    expect(priceIn(650, m)).toBe("$6.50");
    expect(priceIn(13000, m)).toBe("$130");
  });

  test("quotes the member's own currency, zero-decimal included", () => {
    expect(priceIn(900, { currency: "eur", minorFactor: 100 })).toContain("9");
    expect(priceIn(900, { currency: "eur", minorFactor: 100 })).toContain("€");
    // ¥1300 is 1300 minor units, not 13.
    expect(priceIn(1300, { currency: "jpy", minorFactor: 1 })).toContain("1,300");
  });
});

describe("continuationCopy in another currency", () => {
  test("never quotes a EUR member in dollars", () => {
    const eur: DebundlePrice = { ...monthly, currency: "eur", priceCents: 900, introCents: 700 };
    const s = continuationCopy(eur, "monthly", "The Fold");
    expect(s).toContain("€");
    expect(s).not.toContain("$");
  });
});
