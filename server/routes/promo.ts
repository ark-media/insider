// Auto-applied promotions for the checkout form. Returns the best Stripe
// coupon currently flagged for auto-apply (metadata.auto_apply === "true") that
// targets the selected plan, so the UI can preview the discount. The
// authoritative discount is re-discovered and applied at subscription creation
// (server/routes/stripe.ts); this endpoint is display-only.

import type Stripe from 'stripe'
import { makeJsonRes } from '../lib/http.js'
import { listActiveCoupons, pickBestCoupon } from '../lib/stripe-promos.js'
import { getPlanPriceCents } from '../lib/pricing.js'
import type { Deps, Route } from '../lib/route.js'

// Short-lived cache of the coupon list. This endpoint is public and
// unauthenticated, so the cache keeps abusive traffic from hammering Stripe.
// `pickBestCoupon` re-checks `coupon.valid` (redeem_by + limits) on each call,
// so a stale list can never apply an expired coupon. Subscription creation
// (stripe.ts) fetches fresh.
const PROMO_TTL_MS = 60_000
let couponCache: { at: number; coupons: Stripe.Coupon[] } | null = null

async function getCachedCoupons(stripe: Stripe): Promise<Stripe.Coupon[]> {
  const now = Date.now()
  if (couponCache && now - couponCache.at < PROMO_TTL_MS) return couponCache.coupons
  const coupons = await listActiveCoupons(stripe)
  couponCache = { at: now, coupons }
  return coupons
}

export function promoRoutes({ stripe, env, appBaseUrl }: Deps): Route[] {
  return [
    {
      path: '/api/promo/active',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const url = new URL(req.url ?? '/', appBaseUrl)
        const plan = url.searchParams.get('plan')

        if (plan !== 'monthly' && plan !== 'yearly') {
          return json(400, { active: false, error: 'Invalid plan.' })
        }
        if (!stripe) return json(200, { active: false })

        try {
          const [coupons, baseCents] = await Promise.all([
            getCachedCoupons(stripe),
            getPlanPriceCents(stripe, env, plan),
          ])
          const best = pickBestCoupon(coupons, plan, baseCents)
          if (!best) return json(200, { active: false })
          return json(200, {
            active: true,
            name: best.name ?? null,
            kind: best.percent_off != null ? 'percent' : 'amount',
            percent_off: best.percent_off ?? undefined,
            amount_off_cents: best.amount_off ?? undefined,
          })
        } catch (err) {
          // Non-fatal: checkout still works at full price.
          console.error('[promo] active lookup failed:', err)
          return json(200, { active: false })
        }
      },
    },
  ]
}
