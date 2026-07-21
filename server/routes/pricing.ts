// Public plan pricing for the marketing page. Reads the live Stripe Price
// amounts so the UI never hardcodes a number that could drift from what we
// actually charge.

import { makeJsonRes } from '../lib/http.js'
import { getAllTierPricing } from '../lib/pricing.js'
import type { Deps, Route } from '../lib/route.js'

export function pricingRoutes({ stripe }: Deps): Route[] {
  return [
    {
      path: '/api/pricing',
      handler: async (_req, res) => {
        const json = makeJsonRes(res)
        if (!stripe) return json(500, { error: 'Stripe not configured' })
        try {
          // Per-tier prices ({ 'ark-plus' | circle | bundle }: { monthly_cents,
          // yearly_cents }). The client renders all three from this. Founding is
          // cut for launch (§5), so no founding_multiple is served.
          const tiers = await getAllTierPricing(stripe)
          json(200, { tiers })
        } catch (err) {
          console.error('[pricing] lookup failed:', err)
          json(502, { error: 'Could not load pricing' })
        }
      },
    },
  ]
}
