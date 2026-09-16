// The house promo for the checkout form: the best Stripe coupon currently
// flagged for auto-apply (metadata.auto_apply === "true") that targets what the
// buyer is buying, plus THE CODE that applies it.
//
// The code is the point. A Checkout Session takes either a server-set
// `discounts` array or `allow_promotion_codes` — never both (Stripe: "You may
// only specify one of these parameters") — and the buyer needs a field to type
// their own code into, so the sessions carry `allow_promotion_codes` and every
// discount, house sale included, is applied in the browser by code. This
// endpoint is what tells the browser which code that is.
//
// Public and unauthenticated: it only ever returns a code any buyer could
// redeem (auto-apply, active, not reserved for one customer), which is the same
// code the checkout would have applied for them anyway.

import type Stripe from 'stripe'
import {
  listActiveCoupons,
  listPromotionCodes,
  pickAutoApplyPromo,
} from '../lib/stripe-promos.js'
import {
  isSupportedCurrency,
  resolveCatalogPrice,
  resolveGiftPrice,
  type GiftTerm,
  type Plan,
} from '../lib/pricing.js'
import { coerceTier } from './stripe/helpers.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'

// Short-lived cache of the coupon + code lists. This endpoint is public and
// unauthenticated, so the cache keeps abusive traffic from hammering Stripe.
// `pickBestCoupon` re-checks `coupon.valid` (redeem_by + limits) on each call,
// and Stripe re-checks the code itself at redemption, so a stale list can't
// discount anyone it shouldn't — the worst case is a dead code the browser
// tries once and drops.
const PROMO_TTL_MS = 60_000
let promoCache: {
  at: number
  coupons: Stripe.Coupon[]
  codes: Stripe.PromotionCode[]
} | null = null

async function getCachedPromos(stripe: Stripe) {
  const now = Date.now()
  if (promoCache && now - promoCache.at < PROMO_TTL_MS) return promoCache
  const [coupons, codes] = await Promise.all([
    listActiveCoupons(stripe),
    listPromotionCodes(stripe, { active: true }),
  ])
  promoCache = { at: now, coupons, codes }
  return promoCache
}

// Tests drive several different catalogs through one module instance; without
// this the first one would be served to all of them for a minute.
export function __resetPromoCacheForTests(): void {
  promoCache = null
}

export function promoRoutes({ stripe, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      // ?plan=monthly|yearly   — a membership; the plan targets the coupon
      // ?term=6mo|1yr          — a gift; any auto-apply coupon qualifies
      // &tier=, &currency=     — what's being bought, and in what
      path: '/api/promo/active',
      handler: async (req, _res, json) => {
        const url = new URL(req.url ?? '/', appBaseUrl)
        const plan = url.searchParams.get('plan')
        const term = url.searchParams.get('term')
        const tier = coerceTier(url.searchParams.get('tier'))
        const rawCurrency = (url.searchParams.get('currency') ?? 'usd').toLowerCase()
        const currency = isSupportedCurrency(rawCurrency) ? rawCurrency : 'usd'

        // One target, so the price lookup and the coupon's plan targeting can't
        // disagree about what's being bought.
        const giftTerm: GiftTerm | null = term === '6mo' || term === '1yr' ? term : null
        const planTarget: Plan | null =
          plan === 'monthly' || plan === 'yearly' ? plan : null
        const target = giftTerm
          ? ({ kind: 'gift', term: giftTerm } as const)
          : planTarget
            ? ({ kind: 'plan', plan: planTarget } as const)
            : null
        if (!target) return json(400, { active: false, error: 'Invalid plan.' })
        if (!stripe) return json(200, { active: false })

        try {
          // Rank against the list price in the charge currency: it decides
          // percent-vs-fixed order, and it's what makes a foreign-currency
          // amount_off coupon (which Stripe would reject) rank at zero. A PWYC
          // buyer paying above the floor ranks on the floor — close enough to
          // order a catalog this size, and the buyer is never charged on it.
          const { coupons, codes } = await getCachedPromos(stripe)
          const price =
            target.kind === 'gift'
              ? await resolveGiftPrice(stripe, tier, target.term)
              : await resolveCatalogPrice(stripe, tier, target.plan)

          const best = pickAutoApplyPromo(
            coupons,
            codes,
            // A gift has no monthly/yearly plan, so plan targeting is ignored
            // for it — the same rule the gift Session used when the server
            // picked the coupon itself.
            target.kind === 'gift' ? null : target.plan,
            price.floors[currency],
            currency,
          )
          if (!best) return json(200, { active: false })
          return json(200, {
            active: true,
            code: best.code,
            name: best.coupon.name ?? null,
            kind: best.coupon.percent_off != null ? 'percent' : 'amount',
            percent_off: best.coupon.percent_off ?? undefined,
            amount_off_cents: best.coupon.amount_off ?? undefined,
          })
        } catch (err) {
          // Non-fatal: checkout still works at full price.
          console.error('[promo] active lookup failed:', err)
          return json(200, { active: false })
        }
      },
    }),
  ]
}
