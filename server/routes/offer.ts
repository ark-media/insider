// ---------------------------------------------------------------------------
// ICMB launch welcome offer.
//
//   GET  /api/offer/check   — may the signed-in member take the offer, and
//     what exactly will they be charged if they do.
//   POST /api/offer/redeem  — move them onto the Bundle at their own cadence,
//     with the offer coupon attached.
//
// The offer moves an existing Ark+ member to the Bundle keeping their cadence,
// at $200 for the first year / $20 for the first three months. Mailed
// 2026-10-05, redeemable through 2026-10-31 (server/lib/welcome-offer.ts).
//
// Why this isn't just change-tier: change-tier bills an entitlement gain with
// `always_invoice` and leaves the billing cycle alone unless the cadence
// changes. This offer re-anchors the cycle to the redemption date as well, so
// the invoice it raises IS the member's first Bundle term — which is where the
// quoted price has to land. With the cycle left alone, a `duration: once`
// coupon would instead be spent on the small proration invoice and the member
// would pay full price at their real renewal.
//
// The shape of the single write:
//   items                   the Bundle price for the cadence they already have
//   billing_cycle_anchor    'now' — the new term starts today
//   proration_behavior      'always_invoice' — credit the unused Ark+ time and
//                           bill the difference on the spot
//   payment_behavior        'error_if_incomplete' — a declined card leaves the
//                           subscription untouched and raises a 402, rather
//                           than applying the change and leaving an open
//                           invoice behind
//   discounts               whatever survives the product change, plus the
//                           offer coupon
//
// Access is immediate and independent of any of that: the item swap is what
// grants the entitlement, and the webhook derives the new tier from the price's
// product and fans out to Beehiiv, Circle and Neon.
//
// VERIFY-PENDING: `always_invoice` together with `billing_cycle_anchor: 'now'`
// is written against the documented API. Confirm against a live test-mode
// subscription that it raises ONE invoice (the reset cycle plus the proration
// credit), not two, before this is exposed.
// ---------------------------------------------------------------------------

import type Stripe from 'stripe'
import { getDb } from '../lib/db.js'
import { requireBillingEmail } from '../lib/guards.js'
import { isSameOrigin, readJson } from '../lib/http.js'
import {
  isSupportedCurrency,
  minorUnitFactors,
  resolveCatalogPrice,
  type Plan,
  type SupportedCurrency,
} from '../lib/pricing.js'
import { discountsSurvivingChange } from '../lib/retention.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { getSessionEmail } from '../lib/session.js'
import {
  blockFor,
  claimOffer,
  findOffer,
  markRedeemed,
  offerAmountFor,
  releaseClaim,
  WELCOME_OFFER_COUPON_ID,
  WELCOME_MONTHLY_DISCOUNT_MONTHS,
  type OfferBlock,
} from '../lib/welcome-offer.js'
import {
  customerIdOf,
  existingDiscountParams,
  findLiveSubscription,
  periodEndIso,
  planFromSubscription,
  releaseScheduleIfAny,
} from './stripe/helpers.js'
import { catalogTierOfSubscription } from './stripe/webhook.js'
import {
  CONSENT_ACCEPTED_AT_KEY,
  MAX_CONSENT_STATEMENT_LEN,
  consentStatementKey,
} from '../../shared/checkout-consent.js'

// Everything that can stop a redemption, roster reasons (welcome-offer.ts)
// plus the subscription-shaped ones only this route can see.
type Ineligible = OfferBlock | 'no_subscription' | 'already_bundle'

function isCardPaymentError(err: unknown): boolean {
  const e = err as { type?: unknown; statusCode?: unknown } | null
  return e?.type === 'StripeCardError' || e?.statusCode === 402
}

// The member's side of the offer: who they are, what they're on, and the
// Bundle price for that cadence. Returns a reason string instead when the
// offer can't apply, so both routes reject on exactly the same grounds.
async function resolveOffer(
  stripe: Stripe,
  env: Record<string, string>,
  email: string,
): Promise<
  | { ok: false; reason: Ineligible }
  | {
      ok: true
      code: string
      sub: Stripe.Subscription
      plan: Plan
      currency: SupportedCurrency
      catalog: Awaited<ReturnType<typeof resolveCatalogPrice>>
    }
> {
  const row = await findOffer(getDb(env), email)
  const block = blockFor(row)
  if (block || !row) return { ok: false, reason: block ?? 'not_invited' }

  const sub = await findLiveSubscription(stripe, email)
  const plan = sub ? planFromSubscription(sub) : null
  if (!sub || !plan) return { ok: false, reason: 'no_subscription' }

  // Nothing to sell someone already on it. Not a product rule — at launch
  // nobody is — but it stops a double submission from re-billing a full term.
  const tier = await catalogTierOfSubscription(sub, stripe)
  if (tier === 'bundle') return { ok: false, reason: 'already_bundle' }

  const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'
  const catalog = await resolveCatalogPrice(stripe, 'bundle', plan)
  return { ok: true, code: row.code, sub, plan, currency, catalog }
}

export function offerRoutes({ env, stripe, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      // Read-only, so a session minted from the offer email is enough to see
      // the page. Redeeming is not — that needs a real sign-in (below).
      path: '/api/offer/check',
      method: 'GET',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })
        if (!env.DATABASE_URL) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const resolved = await resolveOffer(stripe, env, email)
        if (!resolved.ok) return json(200, { eligible: false, reason: resolved.reason })

        const { code, sub, plan, currency, catalog } = resolved
        const amounts = offerAmountFor(catalog.floors, plan, currency)

        // The exact figure the member will be charged, straight from Stripe
        // rather than computed here — it nets the Bundle term against the
        // credit for their unused Ark+ time, and only Stripe knows how far
        // through that term they are. Soft-fails to null: the confirm screen
        // can still render (and still let them proceed) without the line.
        let dueTodayCents: number | null = null
        try {
          const item = sub.items.data[0]
          if (item) {
            const preview = await stripe.invoices.createPreview({
              customer: customerIdOf(sub),
              subscription: sub.id,
              subscription_details: {
                items: [{ id: item.id, price: catalog.priceId }],
                billing_cycle_anchor: 'now',
                proration_behavior: 'always_invoice',
              },
              discounts: [{ coupon: WELCOME_OFFER_COUPON_ID[plan] }],
            })
            dueTodayCents = preview.amount_due
          }
        } catch (err) {
          console.error('[offer] invoice preview failed:', err)
        }

        return json(200, {
          eligible: true,
          offer: {
            code,
            plan,
            currency,
            minorFactor: minorUnitFactors()[currency] ?? 100,
            // What the Bundle lists at, what this offer charges instead, and
            // for how long — the three numbers the page needs to state it.
            bundleCents: amounts.bundleMinor,
            offerCents: amounts.offerMinor,
            discountedTerms: plan === 'yearly' ? 1 : WELCOME_MONTHLY_DISCOUNT_MONTHS,
            dueTodayCents,
            // Today's renewal date, which this offer MOVES: redeeming re-anchors
            // the cycle, so the page must not present it as unchanged.
            currentRenewsAt: periodEndIso(sub),
          },
        })
      },
    }),

    defineRoute({
      path: '/api/offer/redeem',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })
        if (!env.DATABASE_URL) return json(500, { error: 'not_configured' })

        // Signed in for real, not merely holding the link from the offer email
        // (guards.ts) — this bills a card. The client turns the 401's
        // `reauth_required` into a round trip through sign-in and back.
        const email = await requireBillingEmail(req, res, env)
        if (!email) return

        // This switch is what puts the member in the Fold, so it asks the same
        // 18+ confirmation the account upgrade and checkout do, and records it
        // under the same metadata keys. Bounded because it arrives from the
        // browser and Stripe caps a metadata value at 500 characters.
        const body = (await readJson<{ age_statement?: unknown }>(req)) ?? {}
        const ageStatement =
          typeof body.age_statement === 'string' &&
          body.age_statement.trim() !== '' &&
          body.age_statement.length <= MAX_CONSENT_STATEMENT_LEN
            ? body.age_statement
            : null

        const resolved = await resolveOffer(stripe, env, email)
        if (!resolved.ok) return json(409, { error: 'ineligible', reason: resolved.reason })
        const { sub, plan, currency, catalog } = resolved

        const sql = getDb(env)
        // The claim IS the lock: a conditional UPDATE that exactly one of two
        // concurrent requests can match. Taken BEFORE Stripe is touched, so a
        // double submission can't bill twice, and handed back below if the
        // upgrade doesn't go through.
        const code = await claimOffer(sql, email)
        if (!code) return json(409, { error: 'ineligible', reason: 'already_redeemed' })

        const item = sub.items.data[0]
        if (!item) {
          await releaseClaim(sql, code)
          return json(500, { error: 'Could not read your subscription.' })
        }

        try {
          await releaseScheduleIfAny(stripe, sub, env)

          // A retention coupon priced for Ark+ doesn't follow the member onto
          // the Bundle; anything that still fits does. null means "nothing to
          // drop", which is not the same as "clear them" — the offer coupon is
          // being ADDED, so the array has to be built either way.
          const surviving = await discountsSurvivingChange(stripe, sub, { tier: 'bundle', plan })
          const carried =
            surviving === null ? existingDiscountParams(sub) : surviving === '' ? [] : surviving

          const updated = await stripe.subscriptions.update(sub.id, {
            items: [{ id: item.id, price: catalog.priceId }],
            // Start the Bundle term today, so the invoice this raises is the
            // first Bundle year / month and the coupon lands on it.
            billing_cycle_anchor: 'now',
            proration_behavior: 'always_invoice',
            payment_behavior: 'error_if_incomplete',
            discounts: [...carried, { coupon: WELCOME_OFFER_COUPON_ID[plan] }],
            metadata: {
              ...sub.metadata,
              tier: 'bundle',
              plan,
              // The list price of what they're now on. The offer is a discount
              // against it, not a different price.
              amount_cents: String(catalog.floors[currency] ?? catalog.floors.usd),
              currency,
              welcome_offer_code: code,
              ...(ageStatement
                ? {
                    [consentStatementKey(0)]: ageStatement,
                    [CONSENT_ACCEPTED_AT_KEY]: new Date().toISOString(),
                  }
                : {}),
            },
          })

          const invoiceId =
            typeof updated.latest_invoice === 'string'
              ? updated.latest_invoice
              : (updated.latest_invoice?.id ?? null)

          await markRedeemed(sql, code, {
            subscriptionId: updated.id,
            invoiceId,
            plan,
            couponId: WELCOME_OFFER_COUPON_ID[plan],
          })

          // Entitlement is already live — the item swap granted it, and the
          // webhook is fanning it out to Beehiiv, Circle and Neon.
          return json(200, {
            ok: true,
            plan,
            renewsAt: periodEndIso(updated),
          })
        } catch (err) {
          // error_if_incomplete means nothing changed in Stripe, so the offer
          // must go back on the shelf rather than wait out the claim window.
          await releaseClaim(sql, code).catch((e) =>
            console.error('[offer] could not release claim', code, e),
          )
          if (isCardPaymentError(err)) {
            console.warn('[offer] redeem payment failed:', (err as { code?: string }).code)
            return json(402, {
              error:
                'Your card was declined, so your plan hasn’t changed. Update your card under Manage billing and try again.',
              code: 'payment_failed',
            })
          }
          console.error('[offer] redeem failed:', err)
          return json(502, { error: 'Could not apply your offer. Please try again.' })
        }
      },
    }),
  ]
}
