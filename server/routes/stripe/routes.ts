// Stripe checkout + webhook routes.
//
//   POST /api/stripe/create-checkout-session — create a subscription-mode
//     Checkout Session (ui_mode: 'elements') for one of the three tiers
//     (Ark+ / Circle / Bundle) at a per-currency floor or a PWYC uplift. Charges
//     an explicit currency from the catalog price's `currency_options` (which
//     replaced Adaptive Pricing — the two are mutually exclusive). A single-
//     active-subscription guard blocks a second, row-clobbering sub.
//   POST /api/stripe/cancel-subscription   — cancel at period end.
//   POST /api/stripe/reactivate-subscription — undo a pending cancel.
//   GET  /api/stripe/subscription-status   — poll for activation after
//     PaymentIntent confirm (the client races the webhook).
//   GET  /api/stripe/my-subscription       — the signed-in member's cancel
//     schedule, so the account page can persist a "set to cancel" state.
//   POST /api/stripe/webhook               — server-to-server signal from
//     Stripe; the source of truth for SC + entitlement state.

import type Stripe from 'stripe'
import { AlreadySubscribedError } from '../../lib/activation.js'
import { deriveEntitlements } from '../../entitlement.js'
import { getDb } from '../../lib/db.js'
import {
  clearMembershipPending,
  setMembershipPending,
} from '../../lib/membership.js'
import { hasAcceptedRetention, insertCancellationSurvey } from '../../lib/cancellation.js'
import { pickRetentionCoupon, toRetentionOffer } from '../../lib/retention.js'
import {
  isCancelOfferOutcome,
  isCancellationReason,
  MAX_CANCELLATION_NOTE_LEN,
} from '../../../shared/cancellation.js'
import { listActiveCoupons, pickBestCoupon } from '../../lib/stripe-promos.js'
import {
  isSupportedCurrency,
  resolveCatalogPrice,
} from '../../lib/pricing.js'
import { isSameOrigin, readBody, readJson } from '../../lib/http.js'
import { createRateLimiter } from '../../lib/rate-limit.js'
import { getSessionEmail } from '../../lib/session.js'
import { isValidEmail, redactEmail } from '../../../shared/validation.js'
import { defineRoute, type Deps, type Route } from '../../lib/route.js'
import {
  changeIsImmediate,
  coerceTier,
  customerIdOf,
  findLiveSubscription,
  findOrCreateSubscriber,
  MAX_NAME_LEN,
  periodEndIso,
  planFromSubscription,
  releaseScheduleIfAny,
  scheduleIdOf,
  tsToIso,
  validatePwycAmount,
} from './helpers.js'
import { dispatchWebhookEvent, tierFromSubscription } from './webhook.js'

export function stripeRoutes({ env, stripe, appBaseUrl, activator }: Deps): Route[] {
  // Per-email cap on Checkout Session creation. Mirrors the gift flow: a
  // scripted caller can't produce thousands of zombie Sessions / Customer
  // rows. Small enough to catch abuse and large enough that a real buyer
  // retrying a few times doesn't get blocked.
  const subscribeLimiter = createRateLimiter({
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })

  return [
    defineRoute({
      path: '/api/stripe/create-checkout-session',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })

        const body =
          (await readJson<{
            email?: string
            name?: string
            plan?: 'monthly' | 'yearly'
            tier?: string
            currency?: string
            custom_amount_cents?: number
          }>(req)) ?? {}

        // Email is required up front so we can pre-create the Stripe Customer
        // with it (mirroring the gift flow). Without this, subscription-mode
        // Checkout creates the Customer from whatever Elements collects later,
        // which leaves a window — and any Dashboard-created test sub — where
        // customer.email is null and the webhook's activation 500s forever.
        const email = body.email?.trim().toLowerCase()
        if (!email) return json(400, { error: 'Email is required.' })
        if (!isValidEmail(email)) {
          return json(400, { error: 'Please enter a valid email.' })
        }
        if (body.name && body.name.length > MAX_NAME_LEN) {
          return json(400, { error: 'Name is too long.' })
        }
        if (body.plan !== 'monthly' && body.plan !== 'yearly') {
          return json(400, { error: 'plan must be "monthly" or "yearly"' })
        }

        // Rate-limit after input validation so a clearly-malformed request
        // doesn't consume a token from a legitimate retry.
        const wait = subscribeLimiter.take(email)
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, {
            error: 'Too many checkout attempts. Please wait a moment and try again.',
          })
        }

        const plan = body.plan
        const interval: 'month' | 'year' = plan === 'monthly' ? 'month' : 'year'
        const tier = coerceTier(body.tier)

        // Explicit charge currency (per-currency floors replaced Adaptive
        // Pricing, which currency_options disables). The client selects/detects
        // the currency and sends the PWYC amount in it; anything unsupported
        // (and the not-yet-currency-aware client) falls back to USD. Server-side
        // geo-detection of the *default* belongs to the currency-aware client
        // (task 13), which enters the amount in the displayed currency.
        const requestedCurrency = (body.currency ?? '').toLowerCase()
        const currency = isSupportedCurrency(requestedCurrency) ? requestedCurrency : 'usd'

        // Single-active-subscription guard (§8 risk 1). Until the in-place
        // tier-switch flow (task 14), a member with a live sub is sent to
        // account management rather than allowed to mint a second, row-clobbering
        // subscription.
        const existing = await findLiveSubscription(stripe, email)
        if (existing) {
          return json(409, {
            error:
              'You already have an active membership. Manage or change your plan from your account.',
            code: 'already_subscribed',
          })
        }

        // Per-currency floor for this tier+plan from the catalog price's
        // currency_options. PWYC lets the buyer pay more, never less.
        const catalog = await resolveCatalogPrice(stripe, tier, plan)
        const floor = catalog.floors[currency]

        const pwyc = validatePwycAmount(body.custom_amount_cents, floor, currency)
        if ('error' in pwyc) return json(400, { error: pwyc.error })
        const amountCents = pwyc.amountCents

        // Line item: the catalog price for the exact floor (it carries the
        // currency_options the session's `currency` selects), else inline
        // price_data on the catalog PRODUCT for a PWYC uplift. price_data (not
        // product_data) reuses the persistent product — product_data mints a new
        // Product every call, the cause of the sandbox sprawl (§4).
        // Derive the line-item type by indexing into the create params rather
        // than the `Checkout.SessionCreateParams.LineItem` namespace: this SDK
        // version re-exports SessionCreateParams as a plain type alias at the
        // Checkout level, so the `.LineItem` sub-namespace isn't reachable there.
        type CheckoutLineItem = NonNullable<
          Stripe.Checkout.SessionCreateParams['line_items']
        >[number]
        const lineItem: CheckoutLineItem =
          amountCents === floor
            ? { price: catalog.priceId, quantity: 1 }
            : {
                price_data: {
                  currency,
                  product: catalog.productId,
                  unit_amount: amountCents,
                  recurring: { interval },
                  // Exclusive: the amount is pre-tax; Stripe Tax adds tax on top.
                  // Required once automatic_tax is on.
                  tax_behavior: 'exclusive',
                },
                quantity: 1,
              }

        // Auto-apply the best active promo for this plan, ranked in the charge
        // currency (a foreign-currency amount_off coupon can't apply). Discovered
        // fresh from Stripe — the client never influences the discount. Optional,
        // so a lookup failure must never block checkout: log and charge full.
        let discountCoupon: string | null = null
        try {
          const best = pickBestCoupon(
            await listActiveCoupons(stripe),
            plan,
            amountCents,
            currency,
          )
          if (best) discountCoupon = best.id
        } catch (err) {
          console.error('[stripe] promo lookup failed; charging full price:', err)
        }

        // Find-or-reuse a customer so we never mint duplicates for the same
        // email (and so the resulting subscription's customer always has an
        // email). Checkout has historically created a Customer per Session, so
        // one email can map to several (churn-then-resubscribe).
        const customer = await findOrCreateSubscriber(stripe, {
          email,
          name: body.name,
        })

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          ui_mode: 'elements',
          customer: customer.id,
          // Selects which currency_options amount the catalog price charges (and
          // must match the inline price_data currency on the PWYC path).
          currency,
          line_items: [lineItem],
          // Stripe Tax: compute and add tax on top of the (exclusive) price.
          // For Checkout Sessions this also enables automatic_tax on the
          // subscription Checkout creates. Requires Stripe Tax active with
          // registrations in the Dashboard, or session creation errors.
          automatic_tax: { enabled: true },
          // Persist the billing address the buyer enters (BillingAddressElement)
          // back onto the pre-set Customer. Stripe Tax needs it for jurisdiction.
          customer_update: { address: 'auto' },
          ...(discountCoupon ? { discounts: [{ coupon: discountCoupon }] } : {}),
          // Stamp the subscription so the webhook (task 9) derives the tier and
          // records the amount/plan/currency for the membership row. The webhook
          // is authoritative for the tier via the price product's entitlements;
          // this metadata is a cross-check + the source of amount_cents/plan.
          subscription_data: {
            metadata: {
              tier,
              plan,
              amount_cents: String(amountCents),
              currency,
            },
          },
          // Required for ui_mode 'elements'; only used when a payment method
          // needs an off-site redirect (e.g. 3DS). The modal otherwise confirms
          // in place and polls /api/auth/checkout-session.
          return_url: `${appBaseUrl}/?checkout=complete&session_id={CHECKOUT_SESSION_ID}`,
        })

        if (!session.client_secret) {
          return json(500, { error: 'Could not obtain checkout client secret' })
        }

        json(200, {
          checkout_session_id: session.id,
          client_secret: session.client_secret,
          plan,
          tier,
          currency,
        })
      },
    }),

    defineRoute({
      path: '/api/stripe/cancel-subscription',
      method: 'POST',
      handler: async (req, _res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        const cancelEmail = await getSessionEmail(req, env)
        if (!cancelEmail) return json(401, { error: 'unauthenticated' })

        // Cancel now carries the retention survey: a required reason slug, an
        // optional free-text note, and which offer outcome led here. `reason`
        // and `offer_outcome` are validated against the shared allowlist so a
        // crafted body can't store junk (or smuggle an 'accepted' outcome,
        // which only the accept endpoint writes).
        const body =
          (await readJson<{
            reason?: unknown
            note?: unknown
            offer_outcome?: unknown
          }>(req)) ?? {}
        if (!isCancellationReason(body.reason)) {
          return json(400, { error: 'A cancellation reason is required.' })
        }
        const offerOutcome = isCancelOfferOutcome(body.offer_outcome)
          ? body.offer_outcome
          : 'not_offered'
        const note =
          typeof body.note === 'string' && body.note.trim()
            ? body.note.trim().slice(0, MAX_CANCELLATION_NOTE_LEN)
            : null

        const sub = await findLiveSubscription(stripe, cancelEmail)
        if (!sub) return json(404, { error: 'No active subscription found' })

        // Record the survey before cancelling — but never let an analytics
        // write block the member's cancellation. A DB hiccup degrades to "we
        // lost the reason," not "we couldn't cancel." Skipped entirely when no
        // DB is configured (e.g. a Stripe-only preview env).
        if (env.DATABASE_URL) {
          try {
            await insertCancellationSurvey(getDb(env), {
              email: cancelEmail,
              reason: body.reason,
              note,
              offerOutcome,
              couponId: null,
            })
          } catch (err) {
            console.error('[stripe] cancellation survey write failed:', err)
          }
        }

        // A pending tier/PWYC change makes the sub schedule-managed, and Stripe
        // rejects cancel_at_period_end on such a sub — release the schedule first
        // (cancel supersedes the pending change). Also clears the pending row.
        await releaseScheduleIfAny(stripe, sub, env)

        // Cancel at period end so they keep access until the billing cycle ends.
        await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true })

        json(200, { ok: true, access_until: periodEndIso(sub) })
      },
    }),

    defineRoute({
      // Undo a pending cancel: clear cancel_at_period_end so the subscription
      // renews normally again. Only reachable while the cancel is still
      // scheduled (the sub stays `active` until the period ends); once it has
      // lapsed the member is no longer Ark+ and re-subscribes via checkout
      // instead. Unlike accept-retention-offer this attaches no coupon and
      // burns no eligibility — it's a plain resume. The webhook's
      // syncScCancelSchedule mirrors the cleared schedule back to SC.
      path: '/api/stripe/reactivate-subscription',
      method: 'POST',
      handler: async (req, _res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })

        // Resume the current plan: drop any pending period-end change (schedule)
        // and clear a pending cancel. Update Stripe only when there's actually
        // something to undo — a pending downgrade (schedule) or a pending cancel
        // — so a plain reactivate on an already-renewing sub stays a no-op.
        const hadSchedule = Boolean(scheduleIdOf(sub))
        await releaseScheduleIfAny(stripe, sub, env)
        const updated =
          sub.cancel_at_period_end || hadSchedule
            ? await stripe.subscriptions.update(sub.id, {
                cancel_at_period_end: false,
              })
            : sub

        json(200, { ok: true, next_charge_at: periodEndIso(updated) })
      },
    }),

    defineRoute({
      // Is this member eligible for a retention discount, and what is it? Read
      // on open of the cancel flow: eligible iff they have an active sub AND a
      // valid retention coupon is configured AND they've never accepted before.
      // Every ineligible branch returns the same {eligible:false, offer:null}
      // so the client can't tell *why* — the member never learns an offer
      // existed. Failures fail closed (no offer), never 500 the flow.
      path: '/api/stripe/retention-offer',
      method: 'GET',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const ineligible = { eligible: false, offer: null }

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(200, ineligible)

        // Offered once per member, ever — eligibility burns on accept. A read
        // failure fails closed: better to skip the offer than hand a second one
        // to someone who already accepted. Skipped only when no DB is
        // configured (preview env), where there's no place to burn eligibility.
        if (env.DATABASE_URL) {
          try {
            if (await hasAcceptedRetention(getDb(env), email)) {
              return json(200, ineligible)
            }
          } catch (err) {
            console.error('[stripe] retention eligibility check failed:', err)
            return json(200, ineligible)
          }
        }

        let coupon
        try {
          coupon = pickRetentionCoupon(
            await listActiveCoupons(stripe),
            planFromSubscription(sub),
          )
        } catch (err) {
          console.error('[stripe] retention coupon lookup failed:', err)
          return json(200, ineligible)
        }
        if (!coupon) return json(200, ineligible)

        json(200, { eligible: true, offer: toRetentionOffer(coupon) })
      },
    }),

    defineRoute({
      // Accept the retention offer: attach the coupon to the live subscription
      // and clear any pending cancel in one update, so a member who had already
      // scheduled a cancellation is fully reinstated. The coupon is re-derived
      // server-side (never trusted from the client) and an accepted survey row
      // is written, which burns eligibility.
      path: '/api/stripe/accept-retention-offer',
      method: 'POST',
      handler: async (req, _res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })

        const coupon = pickRetentionCoupon(
          await listActiveCoupons(stripe),
          planFromSubscription(sub),
        )
        if (!coupon) return json(409, { error: 'No retention offer available.' })

        // Once-ever guard: reject a repeat accept *before* touching Stripe.
        // Re-applying a repeating coupon resets its discount window, so a
        // member could otherwise renew a one-time save indefinitely by
        // replaying this POST — the offer must burn on the first accept. A read
        // failure fails closed (reject), matching the GET's posture; the DB
        // unique index on accepted rows is the hard backstop against races.
        // Skipped only when no DB is configured (preview env — no burn there).
        if (env.DATABASE_URL) {
          let alreadyAccepted = true
          try {
            alreadyAccepted = await hasAcceptedRetention(getDb(env), email)
          } catch (err) {
            console.error('[stripe] retention accept eligibility check failed:', err)
          }
          if (alreadyAccepted) {
            return json(409, { error: 'Retention offer already used.' })
          }
        }

        // A schedule-managed sub rejects this update — release any pending
        // change first so the retention save reinstates the current plan cleanly.
        await releaseScheduleIfAny(stripe, sub, env)
        const updated = await stripe.subscriptions.update(sub.id, {
          discounts: [{ coupon: coupon.id }],
          cancel_at_period_end: false,
        })

        if (env.DATABASE_URL) {
          try {
            await insertCancellationSurvey(getDb(env), {
              email,
              reason: null,
              note: null,
              offerOutcome: 'accepted',
              couponId: coupon.id,
            })
          } catch (err) {
            // The discount is applied; losing the row only affects admin
            // analytics (the once-ever guard is backstopped by the DB unique
            // index). Log, don't fail the accept.
            console.error('[stripe] retention accept survey write failed:', err)
          }
        }

        json(200, {
          ok: true,
          percentOff: coupon.percent_off,
          amountOff: coupon.amount_off,
          durationMonths: coupon.duration_in_months ?? null,
          next_charge_at: periodEndIso(updated),
        })
      },
    }),

    defineRoute({
      path: '/api/stripe/subscription-status',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })
        const url = new URL(req.url ?? '/', appBaseUrl)
        const subId = url.searchParams.get('id')
        if (!subId) return json(400, { error: 'id required' })

        const sub = await stripe.subscriptions.retrieve(subId, {
          expand: ['customer'],
        })

        // Authorize the caller in one of two ways:
        //  1. A logged-in session whose email owns this subscription.
        //  2. Possession of the Checkout Session that created it. New
        //     subscribers may not have an Auth0 session yet (they just paid),
        //     so they pass the `session_id` from the return_url — a
        //     high-entropy id held only by the buyer.
        // A self-asserted `?email=` is deliberately NOT accepted: the email is
        // guessable, so trusting it was an IDOR (anyone could read another
        // customer's status by pairing their email with a subscription id).
        const auth0Email = await getSessionEmail(req, env)
        const customer = sub.customer
        const customerEmail =
          typeof customer === 'object' && customer && !('deleted' in customer && customer.deleted)
            ? (customer as Stripe.Customer).email?.toLowerCase() ?? null
            : null

        let authorized =
          Boolean(auth0Email) && auth0Email === customerEmail
        if (!authorized) {
          const sessionId = url.searchParams.get('session_id')
          if (sessionId) {
            const cs = await stripe.checkout.sessions.retrieve(sessionId)
            const csSubId =
              typeof cs.subscription === 'string'
                ? cs.subscription
                : cs.subscription?.id ?? null
            authorized = csSubId === subId
          }
        }
        if (!authorized) return json(403, { error: 'Forbidden' })

        json(200, {
          status: sub.status,
          // Provisioning is complete once ANY external-access axis is marked, not
          // just SC: a Circle-only purchase never carries sc_subscription_id, so
          // keying activation on it alone left the post-checkout poll spinning
          // forever for Circle/Bundle buyers. Either axis marker means the webhook
          // has provisioned what this tier grants.
          activated:
            Boolean(sub.metadata?.sc_subscription_id) ||
            sub.metadata?.circle_provisioned === 'true',
        })
      },
    }),

    defineRoute({
      // The signed-in member's cancel schedule, for the account page to show a
      // persistent "scheduled to cancel" state across reloads — the in-page
      // confirmation after cancelling is transient client state and is lost on
      // refresh. Keyed by the session email (never a self-asserted one). A
      // scheduled cancel keeps the subscription `status: 'active'` until the
      // period actually ends, so findLiveSubscription still matches it. Fails
      // closed to "no pending cancel" so a Stripe hiccup degrades to showing the
      // cancel button rather than an error.
      path: '/api/stripe/my-subscription',
      method: 'GET',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findLiveSubscription(stripe, email)
        // When cancel_at_period_end is set, Stripe populates cancel_at; fall back
        // to the current period end so we always have a date to show.
        let cancelAt: string | null = null
        if (sub?.cancel_at_period_end) {
          cancelAt = tsToIso(sub.cancel_at) ?? periodEndIso(sub)
        }
        json(200, {
          cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
          cancelAt,
          // A schedule-managed sub has a pending period-end tier/PWYC change
          // (task 14). The account page can surface "a plan change is scheduled".
          pendingChange: Boolean(sub && scheduleIdOf(sub)),
        })
      },
    }),

    defineRoute({
      // Switch tier / plan / PWYC amount on the member's existing subscription
      // — the in-app flow the single-active-subscription guard routes a second
      // purchase into (§1a, §6). Direction decides timing: gaining an
      // entitlement (or a PWYC raise / monthly→yearly) applies immediately and
      // prorated; losing one (or a PWYC lower) lands at period end via a Stripe
      // schedule. The webhook fans out on the resulting entitlement diff.
      //
      // VERIFY-PENDING (§6): the schedule phase-boundary handling and the
      // proration behavior are written against the documented API and must be
      // confirmed against a live test-mode sub before this is exposed.
      path: '/api/stripe/change-tier',
      method: 'POST',
      handler: async (req, _res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const body =
          (await readJson<{
            tier?: string
            plan?: 'monthly' | 'yearly'
            custom_amount_cents?: number
          }>(req)) ?? {}
        if (body.plan !== 'monthly' && body.plan !== 'yearly') {
          return json(400, { error: 'plan must be "monthly" or "yearly"' })
        }
        const plan = body.plan
        const interval: 'month' | 'year' = plan === 'monthly' ? 'month' : 'year'
        const newTier = coerceTier(body.tier)

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })
        const customerId = customerIdOf(sub)

        // A EUR sub updated with USD price_data hard-fails (§6 point 1) — reuse
        // the subscription's own currency, and validate against ITS floor.
        const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'
        const catalog = await resolveCatalogPrice(stripe, newTier, plan)
        const floor = catalog.floors[currency] ?? catalog.floors.usd

        const pwyc = validatePwycAmount(body.custom_amount_cents, floor, currency)
        if ('error' in pwyc) return json(400, { error: pwyc.error })
        const amountCents = pwyc.amountCents

        const currentTier = await tierFromSubscription(sub, stripe)
        const prevEnt = deriveEntitlements(currentTier)
        const nextEnt = deriveEntitlements(newTier)
        const item = sub.items.data[0]
        if (!item) return json(409, { error: 'Subscription has no item to change.' })
        const prevAmount = item.price?.unit_amount ?? null
        const prevPlan = planFromSubscription(sub)

        // No-op: identical tier, plan, and amount.
        if (currentTier === newTier && prevPlan === plan && prevAmount === amountCents) {
          return json(200, { ok: true, changed: false })
        }

        // The destination line item. Both the immediate update and the schedule
        // phase can carry inline price_data, so an above-floor PWYC amount is
        // billed at that amount on either path — at the floor we reuse the
        // catalog Price id, above it we mint an inline price for the chosen
        // amount. (Recording amountCents in Neon while billing the floor was a
        // silent undercharge + Neon↔Stripe drift.)
        const atFloor = amountCents === floor
        const destinationPrice = atFloor
          ? { price: catalog.priceId }
          : {
              price_data: {
                currency,
                product: catalog.productId,
                unit_amount: amountCents,
                recurring: { interval },
                tax_behavior: 'exclusive' as const,
              },
            }
        const immediate = changeIsImmediate(prevEnt, nextEnt, prevAmount, amountCents)

        try {
          if (immediate) {
            // Release any prior pending change, then update the item in place
            // (preserves the item id) with exact prorations. The webhook derives
            // the new tier from the price product and syncs SC/Circle/Neon.
            await releaseScheduleIfAny(stripe, sub, env)
            const priceField = destinationPrice
            await stripe.subscriptions.update(sub.id, {
              items: [{ id: item.id, ...priceField }],
              proration_behavior: 'create_prorations',
              // monthly→yearly resets the billing cycle to now (§6 table).
              ...(prevPlan !== plan ? { billing_cycle_anchor: 'now' as const } : {}),
              metadata: {
                ...sub.metadata,
                tier: newTier,
                plan,
                amount_cents: String(amountCents),
                currency,
              },
            })
            if (env.DATABASE_URL) {
              await clearMembershipPending(getDb(env), customerId)
            }
            return json(200, { ok: true, changed: true, timing: 'immediate' })
          }

          // Period-end: schedule the destination price to start at the current
          // period end; entitlement isn't revoked until it lands.
          let scheduleId = scheduleIdOf(sub)
          if (!scheduleId) {
            const created = await stripe.subscriptionSchedules.create({
              from_subscription: sub.id,
            })
            scheduleId = created.id
          }
          const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
          // The phase covering NOW — the active period we must preserve as phase 0.
          // A freshly-created schedule has exactly this phase; a schedule that
          // already carries a pending change has [active, future], and taking the
          // LAST phase would grab the future one, rebuild the schedule off it, and
          // drop the current period. Match by timestamp, falling back to phase 0.
          const nowSec = Math.floor(Date.now() / 1000)
          const currentPhase =
            schedule.phases.find(
              (p) => p.start_date <= nowSec && (p.end_date == null || nowSec < p.end_date),
            ) ?? schedule.phases[0]
          if (!currentPhase) {
            return json(500, { error: 'Could not read subscription schedule.' })
          }
          await stripe.subscriptionSchedules.update(scheduleId, {
            end_behavior: 'release',
            phases: [
              {
                items: currentPhase.items.map((i) => ({
                  price: typeof i.price === 'string' ? i.price : i.price.id,
                  quantity: i.quantity ?? 1,
                })),
                start_date: currentPhase.start_date,
                end_date: currentPhase.end_date,
              },
              { items: [{ ...destinationPrice, quantity: 1 }] },
            ],
          })
          if (env.DATABASE_URL) {
            await setMembershipPending(getDb(env), customerId, {
              scheduled_tier: newTier,
              schedule_id: scheduleId,
              pending_amount_cents: amountCents,
              pending_plan: plan,
            })
          }
          return json(200, {
            ok: true,
            changed: true,
            timing: 'period_end',
            effective_at: periodEndIso(sub),
          })
        } catch (err) {
          console.error('[stripe] change-tier failed:', err)
          return json(502, { error: 'Could not change your plan. Please try again.' })
        }
      },
    }),

    defineRoute({
      // Reads the raw body via readBody() before any JSON parsing. Stripe's
      // signature is over the exact bytes Stripe sent, so any upstream body
      // parser would invalidate constructEvent().
      path: '/api/stripe/webhook',
      method: 'POST',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })
        const whSecret = env.STRIPE_WEBHOOK_SECRET
        if (!whSecret) return json(500, { error: 'not_configured' })

        const sig = req.headers['stripe-signature']
        if (typeof sig !== 'string') return json(400, { error: 'Missing signature' })

        const raw = await readBody(req)
        let event: Stripe.Event
        try {
          event = stripe.webhooks.constructEvent(raw, sig, whSecret)
        } catch (err) {
          console.error('[dev-api] webhook signature verification failed:', err)
          return json(400, { error: 'invalid signature' })
        }

        // Idempotency: claim this event.id before doing any work. Stripe
        // delivers at least once, so a replay/retry must be inert. If the row
        // already exists we've processed it — ack 200 and skip. A ledger error
        // is non-fatal: fall through and process (dispatch is largely
        // metadata-idempotent on its own).
        let claimedEventId: string | null = null
        if (env.DATABASE_URL) {
          try {
            const sql = getDb(env)
            const rows = await sql`
              insert into stripe_webhook_events (id, type)
              values (${event.id}, ${event.type})
              on conflict (id) do nothing
              returning id`
            if (rows.length === 0) {
              return json(200, { received: true, deduped: true })
            }
            claimedEventId = event.id
          } catch (err) {
            console.error('[dev-api] webhook idempotency ledger failed:', err)
          }
        }

        try {
          await dispatchWebhookEvent(event, stripe, env, activator)
          json(200, { received: true })
        } catch (err) {
          if (err instanceof AlreadySubscribedError) {
            // The buyer already has an active SC sub — retrying the webhook
            // won't fix that, so ack 200 and rely on the auth route's 409 to
            // surface the situation to the buyer. Terminal: keep the claim so a
            // retry doesn't reprocess. Manual billing follow-up.
            console.warn('[dev-api] webhook: already subscribed:', redactEmail(err.email))
            return json(200, { received: true, skipped: 'already_subscribed' })
          }
          // Retryable failure: release the claim so Stripe's retry reprocesses
          // the event rather than getting deduped into a no-op.
          if (claimedEventId) {
            try {
              await getDb(env)`delete from stripe_webhook_events where id = ${claimedEventId}`
            } catch (delErr) {
              console.error('[dev-api] webhook claim release failed:', delErr)
            }
          }
          console.error('[dev-api] webhook handler error:', err)
          if (err && typeof err === 'object' && 'data' in err) {
            console.error('[dev-api] webhook error data:', JSON.stringify((err as { data: unknown }).data, null, 2))
          }
          json(500, { error: 'webhook handler error' })
        }
      },
    }),
  ]
}
