// Client-side currency helpers. Every amount from /api/pricing is in MINOR
// units (what Stripe charges); the minor-unit factor per currency comes from
// the same response, so the client never duplicates Stripe's zero-decimal list.
// Display uses Intl.NumberFormat, which places the symbol and picks the decimal
// count correctly per locale + currency.

export type TierAmounts = {
  monthly_cents: number; // USD, back-compat
  yearly_cents: number; // USD, back-compat
  monthly: Record<string, number>; // per-currency floor, minor units
  yearly: Record<string, number>;
};

export type PricingResponse = {
  default_currency: string;
  currencies: string[];
  minor_factors: Record<string, number>;
  tiers: Record<string, TierAmounts>;
};

// minor → major (48588 ILS /100 = 485.88; 21125 JPY /1 = 21125).
export function toMajor(minor: number, factor: number): number {
  return minor / factor;
}

// major → minor, rounded to a whole minor unit (Stripe charges integers).
export function toMinor(major: number, factor: number): number {
  return Math.round(major * factor);
}

// Currencies Stripe requires charge amounts to be an exact multiple of 100, even
// though ISO/CLDR treats them as 2-decimal. They charge in hundredths (factor
// 100) but have no circulating subunit, so a fractional major amount produces a
// non-×100 minor amount that Stripe rejects — the input must round to whole
// units. (Intl can't surface this: it reports HUF/TWD as 2-decimal.)
const HUNDRED_DIVISIBLE_CURRENCIES = new Set(["huf", "twd", "ugx"]);

// Fraction digits the amount field should allow for a currency: 0 for
// zero-decimal currencies (factor 1) and for the hundred-divisible quirk
// currencies above, else 2. Drives the input's step + rounding. Deliberately
// distinct from the minor-unit factor — HUF charges in hundredths yet must round
// to whole major units.
export function decimalsForCurrency(currency: string, factor: number): number {
  if (factor === 1) return 0;
  if (HUNDRED_DIVISIBLE_CURRENCIES.has(currency.toLowerCase())) return 0;
  return 2;
}

// Localized currency formatter. Uses the narrow symbol ("$", not "US$" — the
// currency selector disambiguates) and drops a trailing ".00" on whole amounts
// so the big hero reads cleanly ("$130", "₪485.88", "¥21,125").
function fmt(currency: string, major: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: Number.isInteger(major) ? 0 : undefined,
  }).format(major);
}

// A MINOR-unit amount as a localized currency string.
export function formatMinor(
  minor: number,
  currency: string,
  factor: number,
): string {
  return fmt(currency, toMajor(minor, factor));
}

// A MAJOR-unit amount as a localized currency string.
export function formatMajor(major: number, currency: string): string {
  return fmt(currency, major);
}

// The discount portion of a Stripe coupon as a localized string, e.g. "20% off"
// or "$5 off". amount_off coupons carry their own fixed currency (the server
// mints them in USD — see server/lib/admin-promos.ts), so format the amount in
// THAT currency via Intl rather than hardcoding "$". amount_off is in the
// currency's minor unit; our coupon currencies are all 2-decimal, so /100 →
// major. percent coupons are currency-agnostic.
export function formatCouponDiscount(
  percentOff: number | null | undefined,
  amountOffCents: number | null | undefined,
  currency?: string | null,
): string {
  if (percentOff != null) return `${percentOff}% off`;
  if (amountOffCents != null)
    return `${formatMajor(amountOffCents / 100, currency ?? "usd")} off`;
  return "a discount";
}

// The currency symbol alone (for the edit-mode prefix), e.g. "£", "¥", "R$".
// Falls back to the ISO code if the runtime can't resolve a narrow symbol.
export function currencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? currency.toUpperCase();
}

// Best-effort ISO 3166 country from the browser locale, e.g. "he-IL" → "IL",
// and even bare "he" → "IL" via maximize(). Sent to /api/pricing as a soft
// hint so the default presentment currency is localized when the platform geo
// header is missing (local dev, or an edge/proxy that strips it). The real geo
// IP still wins server-side; this is only a fallback. undefined when the runtime
// can't resolve a region.
export function browserCountry(): string | undefined {
  try {
    const lang =
      (typeof navigator !== "undefined" &&
        (navigator.languages?.[0] ?? navigator.language)) ||
      undefined;
    if (!lang) return undefined;
    const region = new Intl.Locale(lang).maximize().region;
    return region ?? undefined;
  } catch {
    return undefined;
  }
}
