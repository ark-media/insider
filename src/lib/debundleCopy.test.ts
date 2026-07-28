// Tests for the debundle price copy. These assert promises about money, so the
// cadence distinction is the point: one 6-month coupon reads as "6 months" to a
// monthly member and "your first year" to an annual one, because that is what
// Stripe actually charges each of them.

import { describe, test, expect } from "bun:test";
import { continuationCopy, introTerm, usd } from "./debundleCopy";
import type { DebundlePrice } from "../../shared/retention";

// $8/mo standalone → $6.50/mo intro (half the $13 bundle), 6-month coupon.
const monthly: DebundlePrice = {
  tier: "circle",
  plan: "monthly",
  priceCents: 800,
  introCents: 650,
  introMonths: 6,
};

// $80/yr standalone → $65/yr intro (half the $130 bundle), same 6-month coupon.
const yearly: DebundlePrice = {
  tier: "circle",
  plan: "yearly",
  priceCents: 8000,
  introCents: 6500,
  introMonths: 6,
};

const noIntro: DebundlePrice = {
  tier: "ark-plus",
  plan: "monthly",
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
    const s = continuationCopy(monthly, "monthly", "The Community");
    expect(s).toBe(
      "The Community continues on its own at $6.50/month for 6 months, then $8/month — starting at the end of your current billing period.",
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
    expect(continuationCopy(monthly, null, "The Community")).toContain("$6.50/month");
  });
});

describe("usd", () => {
  test("renders catalog cents as dollars, dropping trailing zeros site-wide", () => {
    expect(usd(650)).toBe("$6.50");
    expect(usd(13000)).toBe("$130");
  });
});
