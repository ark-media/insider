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
//
// Promo create/delete and the cancellations CSV export each leave a row in the
// admin audit log (server/lib/admin-audit.ts).

import { readJson, sendCsv } from '../lib/http.js'
import { requireAdmin } from '../lib/session.js'
import { requireAdminRequest } from '../lib/guards.js'
import { logAdminAction } from '../lib/admin-audit.js'
import { listActiveCoupons, listPromotionCodes } from '../lib/stripe-promos.js'
import { buildPromo, minimumsByCurrency, serializeCoupon } from '../lib/admin-promos.js'
import { getDb } from '../lib/db.js'
import {
  cancellationRowsToCsv,
  getCancellationRows,
  getCancellationSummary,
} from '../lib/cancellation.js'
import {
  isCancellationReason,
  isOfferOutcome,
  type CancellationFilter,
} from '../../shared/cancellation.js'
import type Stripe from 'stripe'
import { resolveCatalogPrice } from '../lib/pricing.js'
import type { Promo } from '../../shared/promo.js'
import { defineRoute } from '../lib/route.js'
import type { Deps, Route } from '../lib/route.js'

// Date-stamped export filename, e.g. cancellations-2026-06-10.csv.
function csvFilename(): string {
  return `cancellations-${new Date().toISOString().slice(0, 10)}.csv`
}

// The audit-log summary for a promo: what identifies it (`label` — the code
// buyers type on create, the coupon's display name on delete, where the code is
// already out of reach), what it takes off, and for how long. Those are what
// someone reading the trail later needs to judge it: "100% off forever" should
// be findable. Nothing here is secret — a promo code is published by design.
function promoSummary(
  coupon: Pick<
    Stripe.CouponCreateParams,
    'percent_off' | 'amount_off' | 'currency' | 'duration' | 'duration_in_months'
  >,
  label: string,
): string {
  const discount =
    coupon.percent_off != null
      ? `${coupon.percent_off}% off`
      : `${coupon.amount_off ?? '?'} ${coupon.currency ?? ''} off`.replace(/\s+/g, ' ')
  const duration =
    coupon.duration === 'repeating'
      ? `repeating x${coupon.duration_in_months ?? '?'}mo`
      : (coupon.duration ?? 'once')
  return `${label} ${discount} duration=${duration}`
}

export function adminRoutes({ stripe, env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/admin/me',
      handler: async (req, _res, json) => {
        const admin = await requireAdmin(req, env)
        json(200, { isAdmin: admin !== null, email: admin?.email ?? null })
      },
    }),
    defineRoute({
      path: '/api/admin/promos',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        if (!stripe) return json(500, { error: 'not_configured' })

        if (req.method === 'GET') {
          const [coupons, codes] = await Promise.all([
            listActiveCoupons(stripe),
            listPromotionCodes(stripe),
          ])
          // A coupon can back several promotion codes; show the first, with its
          // own restrictions. (The back office creates at most one per coupon.)
          const codeByCoupon = new Map<string, Stripe.PromotionCode>()
          for (const pc of codes) {
            const c = pc.promotion.coupon
            const couponId = typeof c === 'string' ? c : c?.id
            if (couponId && !codeByCoupon.has(couponId)) codeByCoupon.set(couponId, pc)
          }
          const promos: Promo[] = coupons.map((c) =>
            serializeCoupon(c, codeByCoupon.get(c.id) ?? null),
          )
          return json(200, { promos })
        }

        if (req.method === 'POST') {
          const built = buildPromo(await readJson(req))
          if (!built.ok) return json(400, { error: built.error })

          const { maxRedemptions, expiresAt, firstTimeTransaction, minimumAmountCents } =
            built.value.restrictions
          // A minimum has to be stated in every currency we sell in, or the
          // code stops working outside USD entirely. The catalog's own
          // per-currency floors are the ratio — see minimumsByCurrency, which
          // leaves USD out because Stripe derives that one from
          // minimum_amount_currency and rejects it here.
          //
          // Resolved BEFORE the coupon exists. resolveCatalogPrice throws by
          // design — a missing currency_option, a stale lookup_key, a Stripe
          // hiccup — and a throw between the coupon and its code lands outside
          // the rollback below, leaving a live, codeless coupon behind and
          // minting another on every retry. Which is the state the rollback was
          // written to prevent.
          let currencyOptions: Record<string, { minimum_amount: number }> | undefined
          if (built.value.code && minimumAmountCents != null) {
            const { floors } = await resolveCatalogPrice(stripe, 'ark-plus', 'yearly')
            currencyOptions = minimumsByCurrency(minimumAmountCents, floors)
          }

          const coupon = await stripe.coupons.create(built.value.coupon)
          let promotionCode: Stripe.PromotionCode | null = null
          if (built.value.code) {
            try {
              promotionCode = await stripe.promotionCodes.create({
                promotion: { type: 'coupon', coupon: coupon.id },
                code: built.value.code,
                ...(maxRedemptions != null ? { max_redemptions: maxRedemptions } : {}),
                ...(expiresAt != null ? { expires_at: expiresAt } : {}),
                ...(firstTimeTransaction || minimumAmountCents != null
                  ? {
                      restrictions: {
                        ...(firstTimeTransaction ? { first_time_transaction: true } : {}),
                        ...(minimumAmountCents != null
                          ? {
                              minimum_amount: minimumAmountCents,
                              minimum_amount_currency: 'usd',
                              currency_options: currencyOptions,
                            }
                          : {}),
                      },
                    }
                  : {}),
              })
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
          await logAdminAction(env, admin, req, {
            action: 'promo.create',
            targetId: coupon.id,
            summary: promoSummary(built.value.coupon, `code=${built.value.code ?? '(none)'}`),
          })
          return json(200, { promo: serializeCoupon(coupon, promotionCode) })
        }

        if (req.method === 'DELETE') {
          const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')
          if (!id) return json(400, { error: 'id required' })
          // Read before it's gone, so the trail says WHAT was deleted and not
          // just an opaque coupon id. Best effort: a failed read must not block
          // the delete the admin asked for.
          let doomed: Stripe.Coupon | null = null
          try {
            doomed = await stripe.coupons.retrieve(id)
          } catch {
            doomed = null
          }
          await stripe.coupons.del(id)
          await logAdminAction(env, admin, req, {
            action: 'promo.delete',
            targetId: id,
            summary: doomed
              ? promoSummary(
                  {
                    percent_off: doomed.percent_off ?? undefined,
                    amount_off: doomed.amount_off ?? undefined,
                    currency: doomed.currency ?? undefined,
                    duration: doomed.duration,
                    duration_in_months: doomed.duration_in_months ?? undefined,
                  },
                  `name=${doomed.name ?? '(none)'}`,
                )
              : null,
          })
          return json(200, { ok: true })
        }

        return json(405, { error: 'Method Not Allowed' })
      },
    }),
    defineRoute({
      // Read-only view of the cancellation survey: outcome + reason aggregates
      // and the most recent rows. Admin-gated like the other back-office routes.
      //   ?outcome=&reason=  — optional filters (narrow the rows + the export).
      //   ?format=csv        — download all matching rows as a CSV instead.
      path: '/api/admin/cancellations',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const outcome = params.get('outcome')
        const reason = params.get('reason')
        if (outcome !== null && !isOfferOutcome(outcome)) {
          return json(400, { error: 'invalid outcome filter' })
        }
        if (reason !== null && !isCancellationReason(reason)) {
          return json(400, { error: 'invalid reason filter' })
        }
        const filter: CancellationFilter = { outcome, reason }
        const wantsCsv = params.get('format') === 'csv'

        if (!env.DATABASE_URL) {
          if (wantsCsv) return sendCsv(res, csvFilename(), cancellationRowsToCsv([]))
          return json(200, { byOutcome: [], byReason: [], recent: [] })
        }

        const sql = getDb(env)
        if (wantsCsv) {
          const rows = await getCancellationRows(sql, filter)
          // A bulk read of member data leaving the site. The trail records the
          // filter and the size of the export — never the rows.
          await logAdminAction(env, admin, req, {
            action: 'cancellations.export',
            summary: `format=csv outcome=${outcome ?? 'any'} reason=${reason ?? 'any'} rows=${rows.length}`,
          })
          return sendCsv(res, csvFilename(), cancellationRowsToCsv(rows))
        }
        return json(200, await getCancellationSummary(sql, { filter }))
      },
    }),
  ]
}
