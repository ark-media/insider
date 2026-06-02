// Admin back-office routes (Stripe promos + an admin-identity probe).
//
//   GET  /api/admin/me     — lightweight "am I an admin?" check the SPA calls
//                            before rendering the back office. Always 200.
//   GET  /api/admin/promos — list coupons with their promotion-code labels.
//   POST /api/admin/promos — create a coupon (+ optional promotion code).
//   DELETE /api/admin/promos?id — delete a coupon (invalidates its codes).
//
// All but /me require the Auth0 "admin" role (server/lib/session.ts). Promos
// stay Stripe-native — Stripe is the source of truth; checkout auto-applies.

import { makeJsonRes, readJson } from '../lib/http.js'
import { requireAdmin } from '../lib/session.js'
import { requireAdminRequest } from '../lib/guards.js'
import { listActiveCoupons } from '../lib/stripe-promos.js'
import { buildPromo, listAllPromotionCodes, serializeCoupon } from '../lib/admin-promos.js'
import type { Promo } from '../../shared/promo.js'
import type { Deps, Route } from '../lib/route.js'

export function adminRoutes({ stripe, env, appBaseUrl }: Deps): Route[] {
  return [
    {
      path: '/api/admin/me',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdmin(req, env)
        json(200, { isAdmin: admin !== null, email: admin?.email ?? null })
      },
    },
    {
      path: '/api/admin/promos',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        if (req.method === 'GET') {
          const [coupons, codes] = await Promise.all([
            listActiveCoupons(stripe),
            listAllPromotionCodes(stripe),
          ])
          // A coupon can back several promotion codes; show the first as its
          // label. (The back office creates at most one per coupon.)
          const codeByCoupon = new Map<string, string>()
          for (const pc of codes) {
            const c = pc.promotion.coupon
            const couponId = typeof c === 'string' ? c : c?.id
            if (couponId && !codeByCoupon.has(couponId)) codeByCoupon.set(couponId, pc.code)
          }
          const promos: Promo[] = coupons.map((c) =>
            serializeCoupon(c, codeByCoupon.get(c.id) ?? null),
          )
          return json(200, { promos })
        }

        if (req.method === 'POST') {
          const built = buildPromo(await readJson(req))
          if (!built.ok) return json(400, { error: built.error })

          const coupon = await stripe.coupons.create(built.value.coupon)
          let code: string | null = null
          if (built.value.code) {
            try {
              const pc = await stripe.promotionCodes.create({
                promotion: { type: 'coupon', coupon: coupon.id },
                code: built.value.code,
              })
              code = pc.code
            } catch (err) {
              // The code string was taken/invalid. Roll back the coupon so a
              // retry doesn't pile up orphaned coupons; report the real reason.
              try {
                await stripe.coupons.del(coupon.id)
              } catch (rollbackErr) {
                console.error('[admin/promos] coupon rollback failed:', rollbackErr)
              }
              const msg = err instanceof Error ? err.message : 'Promotion code creation failed.'
              return json(409, { error: `Could not create promo code: ${msg}` })
            }
          }
          return json(200, { promo: serializeCoupon(coupon, code) })
        }

        if (req.method === 'DELETE') {
          const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')
          if (!id) return json(400, { error: 'id required' })
          await stripe.coupons.del(id)
          return json(200, { ok: true })
        }

        return json(405, { error: 'Method Not Allowed' })
      },
    },
  ]
}
