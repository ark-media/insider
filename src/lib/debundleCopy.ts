// Copy for what a product costs once a bundle is split. Pure and separately
// testable because it states prices to members: the difference between "for 6
// months" and "for your first year" is a promise about money, not phrasing.
//
// A debundle settles at the kept product's standalone catalog price, softened by
// a bounded intro coupon (see server/lib/retention.ts). The subtlety is that one
// coupon term reads differently per cadence — a repeating 6-month coupon
// discounts six MONTHLY invoices, but the single ANNUAL invoice inside its
// window, i.e. a whole discounted year. Telling an annual member "for 6 months"
// would understate what they get; telling them "$65/year for 6 months" is
// incoherent. So the term is always rendered in the member's own billing unit.

import type { DebundlePrice } from "../../shared/retention";
import { formatMinor } from "./currency";

type Plan = "monthly" | "yearly";

// The catalog is priced in USD, so debundle amounts are USD minor units.
export const usd = (cents: number) => formatMinor(cents, "usd", 100);

// How long the intro rate lasts, in the member's own billing terms. Empty string
// when the price carries no bounded intro, so callers can concatenate freely.
export function introTerm(price: DebundlePrice, plan: Plan | null): string {
  const months = price.introMonths;
  if (months == null) return "";
  if (plan === "yearly") {
    // Whole annual invoices inside the coupon window. Anything under a year
    // still discounts the one invoice at the switch, hence the floor of 1.
    const years = Math.max(1, Math.floor(months / 12));
    return years === 1 ? "for your first year" : `for your first ${years} years`;
  }
  return `for ${months} month${months === 1 ? "" : "s"}`;
}

// One sentence for what the kept product costs after the split — shared by the
// selector's summary line and the debundle confirm screen so the two can never
// quote different numbers. Falls back to price-free wording when the catalog
// didn't resolve (a Stripe hiccup): the flow still works, it just can't name a
// figure, which beats blocking a member who wants to leave.
export function continuationCopy(
  price: DebundlePrice | null,
  plan: Plan | null,
  name: string,
): string {
  const tail = "starting at the end of your current billing period.";
  if (!price) {
    return `${name} continues on its own at its standalone price, ${tail}`;
  }
  const cadence = plan === "yearly" ? "year" : "month";
  const list = `${usd(price.priceCents)}/${cadence}`;
  if (price.introCents === null) {
    return `${name} continues on its own at ${list}, ${tail}`;
  }
  return `${name} continues on its own at ${usd(price.introCents)}/${cadence} ${introTerm(price, plan)}, then ${list} — ${tail}`;
}
