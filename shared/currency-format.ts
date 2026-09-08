// ---------------------------------------------------------------------------
// One currency formatter for both halves of the app.
//
// The site and the emails quote the same prices, and they were formatting them
// differently: the client used the viewer's locale with a narrow symbol, the
// server pinned 'en' with the default one. A Canadian member read "$25 a year"
// in the confirm panel and "CA$25 a year" in the email that followed it —
// about the same subscription, minutes apart. AUD and HKD diverged the same
// way.
//
// Two decisions, both deliberate:
//
//   1. The narrow symbol ("$", not "US$" / "CA$"). Where the currency is
//      ambiguous the surrounding UI disambiguates it — the checkout has a
//      currency selector — and a member billed in their own currency does not
//      need it spelled at them.
//   2. 'en-US', not the host or viewer locale. The site is English-only; see
//      shared/format-date.ts for the same rule applied to dates. A viewer in
//      de-DE reading English copy should not meet "25,00 $" inside it.
//
// A round amount drops its ".00": cents on a whole number read as a receipt
// rather than a sentence, and every reader here is prose.
// ---------------------------------------------------------------------------

/**
 * A MAJOR-unit amount as a currency string ("$25", "₪485.88", "¥21,125").
 * Falls back to a bare number + ISO code if the runtime rejects the code, so a
 * bad currency degrades to something readable rather than throwing through a
 * price line.
 */
export function formatCurrencyMajor(major: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      currencyDisplay: 'narrowSymbol',
      ...(Number.isInteger(major) ? { minimumFractionDigits: 0 } : {}),
    }).format(major)
  } catch {
    return `${major} ${currency.toUpperCase()}`
  }
}
