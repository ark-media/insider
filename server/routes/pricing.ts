// Public plan pricing for the marketing page + checkout. Reads the live Stripe
// Price amounts so the UI never hardcodes a number that could drift from what we
// actually charge. Currency-aware: returns the per-currency floors, the minor-
// unit factors, and a geo-detected default currency (manual override via the
// client selector; `?country=XX` overrides the geo header for local testing;
// `?locale_hint=XX` is a soft browser-locale fallback used only when no geo
// header is present).

import {
  getAllTierPricingByCurrency,
  minorUnitFactors,
  SUPPORTED_CURRENCIES,
} from '../lib/pricing.js'
import { countryFromRequest, currencyForCountry } from '../lib/geo-currency.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'

export function pricingRoutes({ stripe }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/pricing',
      handler: async (req, res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          // Precedence: explicit `?country=` test override → real platform geo
          // header → `?locale_hint=` (the client's browser-locale country, a
          // soft fallback for when no geo header is present, e.g. local dev).
          const countryOverride = url.searchParams.get('country') ?? undefined
          const localeHint = url.searchParams.get('locale_hint') ?? undefined
          const country = countryOverride ?? countryFromRequest(req) ?? localeHint
          const defaultCurrency = currencyForCountry(country)

          const byCurrency = await getAllTierPricingByCurrency(stripe)
          // Per tier: the back-compat USD summary (`monthly_cents`/`yearly_cents`)
          // plus the full per-currency floor maps (`monthly`/`yearly`, minor
          // units). Founding is cut for launch (§5), so no founding_multiple.
          const tiers = Object.fromEntries(
            Object.entries(byCurrency).map(([tier, p]) => [
              tier,
              {
                monthly_cents: p.monthly.usd,
                yearly_cents: p.yearly.usd,
                monthly: p.monthly,
                yearly: p.yearly,
              },
            ]),
          )

          json(200, {
            default_currency: defaultCurrency,
            currencies: SUPPORTED_CURRENCIES,
            minor_factors: minorUnitFactors(),
            tiers,
          })
        } catch (err) {
          console.error('[pricing] lookup failed:', err)
          json(502, { error: 'Could not load pricing' })
        }
      },
    }),
  ]
}
