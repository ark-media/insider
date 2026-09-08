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
//   1. The full symbol, which en-US spells "$25" for USD and "CA$25" / "A$25"
//      for the other dollars. The narrow symbol renders every one of them as a
//      bare "$", and the argument for it — that the surrounding UI
//      disambiguates, since the checkout has a currency selector — is true of
//      the site and false of the emails, which are the other half of what this
//      formats. A renewal notice that says "$25 a year" to a member billed in
//      CAD carries nothing anywhere in the message to say which dollar that is,
//      and a billing disclosure is the last place to be ambiguous about it.
//   2. 'en-US', not the host or viewer locale. The site is English-only; see
//      shared/format-date.ts for the same rule applied to dates. A viewer in
//      de-DE reading English copy should not meet "25,00 $" inside it.
//
// A round amount drops its ".00": cents on a whole number read as a receipt
// rather than a sentence, and every reader here is prose.
// ---------------------------------------------------------------------------

/**
 * A MAJOR-unit amount as a currency string ("$25", "CA$25", "₪485.88").
 * Falls back to a bare number + ISO code if the runtime rejects the code, so a
 * bad currency degrades to something readable rather than throwing through a
 * price line.
 */
export function formatCurrencyMajor(major: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      currencyDisplay: 'symbol',
      ...(Number.isInteger(major) ? { minimumFractionDigits: 0 } : {}),
    }).format(major)
  } catch {
    return `${major} ${currency.toUpperCase()}`
  }
}
