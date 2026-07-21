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

// Whole currency units per major unit: 0 decimals for zero-decimal currencies
// (factor 1), else 2. Drives snap steps and input rounding.
export function decimalsForFactor(factor: number): number {
  return factor === 1 ? 0 : 2;
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

// Human label for the selector, e.g. "GBP — British Pound".
export function currencyLabel(currency: string): string {
  const code = currency.toUpperCase();
  try {
    const name = new Intl.DisplayNames(undefined, { type: "currency" }).of(code);
    return name && name.toUpperCase() !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}
