// Public plan pricing for the marketing page. Reads the live Stripe Price
// amounts so the UI never hardcodes a number that could drift from what we
// actually charge.

import { makeJsonRes } from '../lib/http.js'
import { FOUNDING_MULTIPLE, getAllTierPricing } from '../lib/pricing.js'
import type { Deps, Route } from '../lib/route.js'

export function pricingRoutes({ stripe }: Deps): Route[] {
  return [
    {
      path: '/api/pricing',
      handler: async (_req, res) => {
        const json = makeJsonRes(res)
        if (!stripe) return json(500, { error: 'Stripe not configured' })
        try {
          const tiers = await getAllTierPricing(stripe)
          json(200, {
            tiers,
            founding_multiple: FOUNDING_MULTIPLE,
            // Transitional: the current Pricing page reads these top-level Ark+
            // fields. Task 13 reworks Pricing.tsx to render all three tiers off
            // `tiers` and removes these.
            monthly_cents: tiers['ark-plus'].monthly_cents,
            yearly_cents: tiers['ark-plus'].yearly_cents,
          })
        } catch (err) {
          console.error('[pricing] lookup failed:', err)
          json(502, { error: 'Could not load pricing' })
        }
      },
    },
  ]
}
