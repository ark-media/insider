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
// And one request option: an idempotency key (redeemIdempotencyKey), which is
// what stops a double submission billing twice. There is no roster to lock —
// eligibility comes from the member's own subscription (blockFor), and once the
// switch lands the subscription is on the Bundle, which blockFor refuses.
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
  offerAmountFor,
  redeemIdempotencyKey,
  WELCOME_OFFER_COHORT,
  WELCOME_OFFER_COUPON_ID,
  WELCOME_OFFER_KEY,
  WELCOME_OFFER_PLAN_KEY,
  WELCOME_OFFER_REDEEMED_AT_KEY,
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

// Everything that can stop a redemption: blockFor's reasons, plus having no
// live subscription to move at all.
type Ineligible = OfferBlock | 'no_subscription'

// Stripe answering for another request with the same idempotency key: one
// still in flight (409), or one that finished with different parameters.
function isIdempotencyConflict(err: unknown): boolean {
  const e = err as { type?: unknown; statusCode?: unknown } | null
  return e?.type === 'StripeIdempotencyError' || e?.statusCode === 409
}

function isCardPaymentError(err: unknown): boolean {
  const e = err as { type?: unknown; statusCode?: unknown } | null
  return e?.type === 'StripeCardError' || e?.statusCode === 402
}

// The member's side of the offer: who they are, what they're on, and the
// Bundle price for that cadence. Returns a reason string instead when the
// offer can't apply, so both routes reject on exactly the same grounds.
async function resolveOffer(
  stripe: Stripe,
  email: string,
): Promise<
  | { ok: false; reason: Ineligible }
  | {
      ok: true
      sub: Stripe.Subscription
      plan: Plan
      currency: SupportedCurrency
      catalog: Awaited<ReturnType<typeof resolveCatalogPrice>>
    }
> {
  const sub = await findLiveSubscription(stripe, email)
  const plan = sub ? planFromSubscription(sub) : null
  if (!sub || !plan) return { ok: false, reason: 'no_subscription' }

  // The product the subscription is on, from the price (not metadata a member
  // could have been left with). Refusing the Bundle is also what stops a
  // second redemption once the first has landed.
  const tier = await catalogTierOfSubscription(sub, stripe)
  const block = blockFor(sub, tier)
  if (block) return { ok: false, reason: block }

  const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'
  const catalog = await resolveCatalogPrice(stripe, 'bundle', plan)
  return { ok: true, sub, plan, currency, catalog }
}

// The discounts the member ends up with: whatever survives the product change,
// plus the offer coupon. A retention coupon priced for Ark+ doesn't follow the
// member onto the Bundle; anything that still fits does. null from
// discountsSurvivingChange means "nothing to drop", which is not the same as
// "clear them" — the offer coupon is being ADDED, so the array is built either
// way. Shared by the preview and the update so the quoted "due today" and the
// real charge see the same discounts.
async function offerDiscounts(
  stripe: Stripe,
  sub: Stripe.Subscription,
  plan: Plan,
): Promise<Array<{ discount: string } | { coupon: string }>> {
  const surviving = await discountsSurvivingChange(stripe, sub, { tier: 'bundle', plan })
  const carried =
    surviving === null ? existingDiscountParams(sub) : surviving === '' ? [] : surviving
  return [...carried, { coupon: WELCOME_OFFER_COUPON_ID[plan] }]
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

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const resolved = await resolveOffer(stripe, email)
        if (!resolved.ok) return json(200, { eligible: false, reason: resolved.reason })

        const { sub, plan, currency, catalog } = resolved
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
              // The top-level list REPLACES the subscription's own discounts in
              // the preview rather than adding to them (preview params have no
              // subscription-level discounts), so it carries the survivors too.
              discounts: await offerDiscounts(stripe, sub, plan),
            })
            dueTodayCents = preview.amount_due
          }
        } catch (err) {
          console.error('[offer] invoice preview failed:', err)
        }

        return json(200, {
          eligible: true,
          offer: {
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

        const resolved = await resolveOffer(stripe, email)
        if (!resolved.ok) return json(409, { error: 'ineligible', reason: resolved.reason })
        const { sub, plan, currency, catalog } = resolved

        const item = sub.items.data[0]
        if (!item) return json(500, { error: 'Could not read your subscription.' })

        let updated: Stripe.Subscription
        try {
          await releaseScheduleIfAny(stripe, sub, env)

          // Every parameter here must come out the same for two submissions
          // from the same member, or Stripe rejects the second as a key reused
          // with different parameters instead of replaying the first. So
          // nothing time-dependent goes in this call: the redemption date and
          // the consent timestamp are written by the metadata update below.
          // (Stripe merges metadata keys, so nothing needs spreading in.)
          updated = await stripe.subscriptions.update(
            sub.id,
            {
              items: [{ id: item.id, price: catalog.priceId }],
              // Start the Bundle term today, so the invoice this raises is the
              // first Bundle year / month and the coupon lands on it.
              billing_cycle_anchor: 'now',
              proration_behavior: 'always_invoice',
              payment_behavior: 'error_if_incomplete',
              discounts: await offerDiscounts(stripe, sub, plan),
              metadata: {
                tier: 'bundle',
                plan,
                // The list price of what they're now on. The offer is a
                // discount against it, not a different price.
                amount_cents: String(catalog.floors[currency] ?? catalog.floors.usd),
                currency,
                [WELCOME_OFFER_KEY]: WELCOME_OFFER_COHORT,
                [WELCOME_OFFER_PLAN_KEY]: plan,
              },
            },
            { idempotencyKey: redeemIdempotencyKey(sub) },
          )
        } catch (err) {
          if (isIdempotencyConflict(err)) {
            // A second click while the first is still with Stripe. Not an
            // error to act on — the first request is the one that decides.
            return json(409, {
              error:
                'Your offer is already being applied. Give it a minute, then refresh this page.',
              code: 'in_progress',
            })
          }
          // error_if_incomplete means nothing changed in Stripe.
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

        // From here Stripe has switched and charged the member, so nothing
        // below may report failure. The redemption date is what ends the
        // no-stacking window (welcomeDiscountActive), and the 18+ statement is
        // recorded under the same keys the account upgrade and checkout use.
        // A failure here is logged for a manual backfill; until then the
        // marker without a date keeps the cancel flow's coupons withheld.
        try {
          await stripe.subscriptions.update(updated.id, {
            metadata: {
              [WELCOME_OFFER_REDEEMED_AT_KEY]: new Date().toISOString(),
              ...(ageStatement
                ? {
                    [consentStatementKey(0)]: ageStatement,
                    [CONSENT_ACCEPTED_AT_KEY]: new Date().toISOString(),
                  }
                : {}),
            },
          })
        } catch (err) {
          console.error(
            '[offer] REDEEMED BUT DATE/CONSENT NOT RECORDED — backfill subscription metadata',
            { subscriptionId: updated.id, plan, ageStatement: ageStatement !== null },
            err,
          )
        }

        // Entitlement is already live — the item swap granted it, and the
        // webhook is fanning it out to Beehiiv, Circle and Neon.
        return json(200, {
          ok: true,
          plan,
          renewsAt: periodEndIso(updated),
        })
      },
    }),
  ]
}
