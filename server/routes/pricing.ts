// Public plan pricing for the marketing page. Reads the live Stripe Price
// amounts so the UI never hardcodes a number that could drift from what we
// actually charge.

import { makeJsonRes } from '../lib/http.js'
import { getPlanPriceCents } from '../lib/pricing.js'
import type { Deps, Route } from '../lib/route.js'

export function pricingRoutes({ stripe, env }: Deps): Route[] {
  return [
    {
      path: '/api/pricing',
      handler: async (_req, res) => {
        const json = makeJsonRes(res)
        if (!stripe) return json(500, { error: 'Stripe not configured' })
        try {
          const [monthly, yearly] = await Promise.all([
            getPlanPriceCents(stripe, env, 'monthly'),
            getPlanPriceCents(stripe, env, 'yearly'),
          ])
          json(200, { monthly_cents: monthly, yearly_cents: yearly })
        } catch (err) {
          console.error('[pricing] lookup failed:', err)
          json(502, { error: 'Could not load pricing' })
        }
      },
    },
  ]
}
