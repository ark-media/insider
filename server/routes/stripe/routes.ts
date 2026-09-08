// Stripe checkout + webhook routes.
//
//   POST /api/stripe/create-checkout-session — create a subscription-mode
//     Checkout Session (ui_mode: 'elements') for one of the three tiers
//     (Ark+ / Circle / Bundle) at a per-currency floor or a PWYC uplift. Charges
//     an explicit currency from the catalog price's `currency_options` (which
//     replaced Adaptive Pricing — the two are mutually exclusive). A single-
//     active-subscription guard blocks a second, row-clobbering sub.
//   POST /api/stripe/record-consent        — stamp the consent statements the
//     buyer ticked onto their Checkout Session, just before it is confirmed.
//   POST /api/stripe/cancel-subscription   — cancel at period end.
//   POST /api/stripe/reactivate-subscription — undo a pending cancel.
//   GET  /api/stripe/subscription-status   — poll for activation after
//     PaymentIntent confirm (the client races the webhook).
//   GET  /api/stripe/my-subscription       — the signed-in member's cancel
//     schedule, so the account page can persist a "set to cancel" state.
//   GET  /api/stripe/bundle-upgrade-preview — what a single-axis member's
//     subscription becomes when they add the other axis: the Bundle price that
//     REPLACES their current one, and the renewal date that doesn't move.
//   POST /api/stripe/webhook               — server-to-server signal from
//     Stripe; the source of truth for SC + entitlement state.

import type Stripe from 'stripe'
import { AlreadySubscribedError } from '../../lib/activation.js'
import { deriveEntitlements } from '../../entitlement.js'
import { getDb } from '../../lib/db.js'
import {
  clearMembershipPending,
  getScheduledTierByCustomer,
  setMembershipPending,
} from '../../lib/membership.js'
import {
  hasAcceptedRetention,
  insertCancellationSurvey,
  updateCancellationSurveyReasons,
} from '../../lib/cancellation.js'
import {
  bundleBreakdown,
  debundlePricePreview,
  deriveSaveOffers,
  pickIntroCoupon,
} from '../../lib/retention.js'
import {
  intentAllowedForTier,
  isPlanSwitchKind,
  isSaveIntent,
} from '../../../shared/retention.js'
import {
  isCancelOfferOutcome,
  isCancellationReasons,
  isRetainedProduct,
  MAX_CANCELLATION_NOTE_LEN,
} from '../../../shared/cancellation.js'
import { listActiveCoupons, pickBestCoupon } from '../../lib/stripe-promos.js'
import {
  isSupportedCurrency,
  minorUnitFactors,
  resolveCatalogPrice,
} from '../../lib/pricing.js'
import { sanitizeAttribution } from '../../../shared/attribution.js'
import {
  CONSENT_ACCEPTED_AT_KEY,
  MAX_CONSENT_STATEMENTS,
  MAX_CONSENT_STATEMENT_LEN,
  consentStatementKey,
} from '../../../shared/checkout-consent.js'
import { getClientIp, isSameOrigin, readBody, readJson } from '../../lib/http.js'
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
  scheduledPlanOf,
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
  // Keying only on the submitted email let a caller reset the bucket by
  // changing it — which mattered twice over, because this endpoint both writes
  // to Stripe (customer + session) and answers "is this address a member?".
  // The per-IP bucket is what actually bounds enumeration. Vercel overwrites
  // x-forwarded-for with the true client IP, so it can't be spoofed in prod.
  const subscribeIpLimiter = createRateLimiter({
    capacity: 15,
    refillPerSec: 15 / (60 * 60), // 15 per hour per source
  })
  // Per-IP cap on consent writes. One purchase needs one call, and a retried
  // payment a handful; anything past that is a caller spending our Stripe
  // request budget on an endpoint that answers nothing useful.
  const consentLimiter = createRateLimiter({
    capacity: 30,
    refillPerSec: 30 / (60 * 60), // 30 per hour per source
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
            attribution?: unknown
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
        const clientIp = getClientIp(req)
        const wait =
          subscribeIpLimiter.take(clientIp) ?? subscribeLimiter.take(`${clientIp}|${email}`)
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
          // Persist what the buyer enters (BillingAddressElement) back onto the
          // pre-set Customer. Stripe Tax needs the address for jurisdiction;
          // `name` defaults to 'never', which is why customer.name was null for
          // every direct subscriber — and since activation reads the name off
          // the Customer, that null was what made Auth0, Supporting Cast, Circle
          // and every welcome email fall back to the email local part.
          customer_update: { address: 'auto', name: 'auto' },
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
              // Acquisition channel, captured in the browser on first visit and
              // forwarded here (BI plan §4.1). The webhook reads it straight
              // back off the subscription so every server-side revenue event —
              // including renewals and churn months later — carries the channel
              // that produced the member, with no browser session to rejoin.
              // Allowlisted + length-capped: the client is untrusted.
              ...sanitizeAttribution(body.attribution),
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
      // The record half of checkout consent. The browser gates the pay button
      // on two ticked boxes (src/components/CheckoutConsent) and then posts the
      // exact sentences here, which stamps them — and OUR clock, not the
      // browser's — onto the Checkout Session's metadata. Stripe keeps it
      // beside the charge it belongs to, which is what we produce in a dispute.
      //
      // This replaced consent_collection.terms_of_service, which recorded the
      // same fact but could only ever collect one statement, needed a Dashboard
      // terms URL, and needed the beta-gated TermsElement to render at all.
      //
      // Not authenticated, and it can't be: the buyer has no session yet. What
      // it can do is refuse to write anywhere except an OPEN Checkout Session
      // whose id the caller already had — Stripe rejects an update to any
      // other, so a guessed id can't be used to scribble on a paid one.
      path: '/api/stripe/record-consent',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        const body =
          (await readJson<{
            checkout_session_id?: unknown
            statements?: unknown
          }>(req)) ?? {}

        const sessionId = body.checkout_session_id
        if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
          return json(400, { error: 'checkout_session_id is required.' })
        }
        // The statements are copy the browser rendered, so they're recorded as
        // sent — but bounded, because they're also a string an untrusted client
        // chose the length of, and Stripe caps a metadata value at 500.
        const statements = Array.isArray(body.statements)
          ? body.statements.filter(
              (line): line is string => typeof line === 'string' && line.trim() !== '',
            )
          : []
        if (statements.length === 0 || statements.length > MAX_CONSENT_STATEMENTS) {
          return json(400, { error: 'statements is required.' })
        }

        const wait = consentLimiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'Too many requests.' })
        }

        // Merges into the Session's existing metadata rather than replacing it
        // (Stripe unsets a key only when you post an empty value for it), so
        // the gift funnel's own `kind`/`giver_email` survive this write.
        try {
          await stripe.checkout.sessions.update(sessionId, {
            metadata: {
              [CONSENT_ACCEPTED_AT_KEY]: new Date().toISOString(),
              ...Object.fromEntries(
                statements.map((line, i) => [
                  consentStatementKey(i),
                  line.slice(0, MAX_CONSENT_STATEMENT_LEN),
                ]),
              ),
            },
          })
        } catch (err) {
          // The client treats this as non-fatal and pays anyway — a ticked box
          // is consent whether or not the bookkeeping landed — so the log is
          // the only trace. Loud on purpose.
          console.error('[stripe] consent not recorded for', sessionId, err)
          return json(502, { error: 'Could not record consent.' })
        }

        json(200, { ok: true })
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

        // The survey is now collected *after* the cancel commits (the member
        // sees "your subscription has been cancelled" first, then the reasons —
        // survey-after-cancel). So this endpoint only needs which offer outcome
        // led here; the reasons/note arrive later at /cancellation-survey and
        // update the row this write creates. `offer_outcome` is allowlisted so a
        // crafted body can't smuggle an 'accepted' outcome (only the accept
        // endpoint writes that).
        const body =
          (await readJson<{ offer_outcome?: unknown }>(req)) ?? {}
        const offerOutcome = isCancelOfferOutcome(body.offer_outcome)
          ? body.offer_outcome
          : 'not_offered'

        const sub = await findLiveSubscription(stripe, cancelEmail)
        if (!sub) return json(404, { error: 'No active subscription found' })

        // Record the row before cancelling — but never let an analytics write
        // block the member's cancellation. A DB hiccup degrades to "we lost the
        // reasons," not "we couldn't cancel." Skipped when no DB is configured
        // (e.g. a Stripe-only preview env). The record captures the tier being
        // left and retained_product='full-exit' (this endpoint is the full
        // cancel; debundles keep a product via change-tier), so win-back can
        // target it by email even after the membership row is torn down. The
        // returned id lets the client attach the member's reasons afterward.
        let surveyId: string | number | null = null
        if (env.DATABASE_URL) {
          let canceledTier: string | null = null
          try {
            canceledTier = await tierFromSubscription(sub, stripe)
          } catch (err) {
            console.error('[stripe] cancel: tier derivation failed:', err)
          }
          try {
            surveyId = await insertCancellationSurvey(getDb(env), {
              email: cancelEmail,
              reasons: [],
              note: null,
              offerOutcome,
              couponId: null,
              canceledTier,
              retainedProduct: 'full-exit',
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

        json(200, { ok: true, access_until: periodEndIso(sub), survey_id: surveyId })
      },
    }),

    defineRoute({
      // Survey-after-cancel: the member cancelled (row already written by
      // /cancel-subscription), then optionally told us why. Attaches their
      // checked reasons + free-text note to that row, keyed by the survey_id the
      // cancel returned and scoped to their session email so they can only
      // annotate their own row. Best-effort from the member's view — the cancel
      // already committed; a failure here just loses the reasons.
      path: '/api/stripe/cancellation-survey',
      method: 'POST',
      handler: async (req, _res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const body =
          (await readJson<{
            survey_id?: unknown
            reasons?: unknown
            note?: unknown
          }>(req)) ?? {}

        // survey_id is the insert's generated identity — accept the number or its
        // string form (the HTTP driver returns bigint as a string).
        const surveyId =
          typeof body.survey_id === 'number' || typeof body.survey_id === 'string'
            ? body.survey_id
            : null
        if (surveyId === null) return json(400, { error: 'survey_id is required.' })
        if (!isCancellationReasons(body.reasons)) {
          return json(400, { error: 'Invalid cancellation reasons.' })
        }
        const note =
          typeof body.note === 'string' && body.note.trim()
            ? body.note.trim().slice(0, MAX_CANCELLATION_NOTE_LEN)
            : null

        if (env.DATABASE_URL) {
          try {
            await updateCancellationSurveyReasons(getDb(env), {
              id: surveyId,
              email,
              reasons: body.reasons,
              note,
            })
          } catch (err) {
            console.error('[stripe] cancellation survey update failed:', err)
          }
        }

        json(200, { ok: true })
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
      // The ordered save offers for a tier-aware cancel/debundle flow (Flows
      // A–E). The server resolves the member's billing cadence from the live
      // sub and derives amounts/coupons from Stripe (never hardcoded). Coupon
      // offers are suppressed when the member accepted a promotional coupon
      // within the rolling 12 months (Decision #6); plan switches always show.
      // Fails closed to no offers so a Stripe/DB hiccup never blocks the flow.
      path: '/api/stripe/save-offers',
      method: 'GET',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const url = new URL(req.url ?? '', 'http://localhost')
        const intent = url.searchParams.get('intent')
        if (!isSaveIntent(intent)) return json(400, { error: 'bad_intent' })

        const empty = { offers: [], standalone: null }
        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(200, empty)
        const plan = planFromSubscription(sub)
        if (!plan) return json(200, empty)

        let offers
        // For a debundle, the standalone price the *kept* product continues at,
        // shown on the confirm screen (Flows C/D/E). Null for a full cancel.
        let standalone = null
        try {
          offers = await deriveSaveOffers(stripe, intent, plan)
          if (intent === 'debundle-remove-ark-plus') {
            standalone = await debundlePricePreview(stripe, 'circle', plan)
          } else if (intent === 'debundle-remove-circle') {
            standalone = await debundlePricePreview(stripe, 'ark-plus', plan)
          }
        } catch (err) {
          console.error('[stripe] save-offers derivation failed:', err)
          return json(200, empty)
        }

        // Window-suppress promotional coupons (keep plan switches). A read
        // failure fails closed: drop coupon offers rather than risk a repeat.
        if (env.DATABASE_URL) {
          let blocked = true
          try {
            blocked = await hasAcceptedRetention(getDb(env), email)
          } catch (err) {
            console.error('[stripe] save-offers eligibility check failed:', err)
          }
          // A spent window removes the discount, not the switch itself: the
          // member can still change plan, just at the plain catalog price.
          if (blocked) {
            offers = offers
              .filter((o) => isPlanSwitchKind(o.kind))
              .map((o) => ({
                ...o,
                couponId: null,
                label: null,
                percentOff: null,
                amountOff: null,
                durationMonths: null,
              }))
          }
        }

        json(200, { offers, standalone })
      },
    }),

    defineRoute({
      // Accept a coupon-backed save offer (supporter / affordability). The
      // coupon is re-derived server-side for (intent, cadence) — never trusted
      // from the client — attached to the live sub, and any pending cancel is
      // cleared in one update. An accepted survey row is written, which burns the
      // 12-month window. Plan switches (annual/monthly) carry no coupon and go
      // through change-tier instead, not this route.
      path: '/api/stripe/accept-save-offer',
      method: 'POST',
      handler: async (req, _res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const body = (await readJson<{ intent?: unknown; kind?: unknown }>(req)) ?? {}
        if (!isSaveIntent(body.intent)) return json(400, { error: 'bad_intent' })
        const wantKind = body.kind
        if (typeof wantKind !== 'string') return json(400, { error: 'bad_kind' })

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })
        const plan = planFromSubscription(sub)
        if (!plan) return json(409, { error: 'No billing cadence on subscription.' })

        // The intent is a claim from the client, not a fact. Derive the offer
        // set only for a flow this member's ACTUAL tier can open — otherwise a
        // caller picks the offer set (e.g. 'cancel-circle' while on Bundle) and
        // lands another product's coupon on their own subscription.
        const currentTier = await tierFromSubscription(sub, stripe)
        if (!intentAllowedForTier(body.intent, currentTier)) {
          return json(409, { error: 'No such save offer available.' })
        }

        const offers = await deriveSaveOffers(stripe, body.intent, plan)

        const offer = offers.find((o) => o.kind === wantKind && o.couponId)
        // A pure plan switch (annual_switch, no coupon) is applied via
        // change-tier, not here — nothing to attach.
        if (!offer || !offer.couponId) {
          return json(409, { error: 'No such save offer available.' })
        }

        // One temporary promotional discount per rolling 12 months, so a member
        // can't re-enter the cancel flow to collect it again. This covers the
        // discount riding the annual→monthly switch too — it's the same coupon.
        if (env.DATABASE_URL) {
          let blocked = true
          try {
            blocked = await hasAcceptedRetention(getDb(env), email)
          } catch (err) {
            console.error('[stripe] accept-save-offer eligibility check failed:', err)
          }
          if (blocked) return json(409, { error: 'Save offer already used recently.' })
        }

        let updated
        if (isPlanSwitchKind(offer.kind)) {
          // change-tier is supposed to have scheduled the switch already, but
          // only the client calls it — so verify rather than assume. A
          // plan-switch coupon is priced for its target cadence (the monthly
          // supporter rate is configured with metadata.plan = 'monthly'), and
          // attaching it to a subscription still on the old cadence discounts
          // the wrong invoice: a repeating N-month coupon takes its cut off a
          // whole annual charge.
          const target = offer.targetPlan ?? null
          const scheduled = await scheduledPlanOf(stripe, sub)
          if (!target || (plan !== target && scheduled !== target)) {
            return json(409, { error: 'Plan switch not applied.' })
          }
          // Attach the discount alongside the schedule, without releasing it or
          // touching cancel_at_period_end.
          updated = await stripe.subscriptions.update(sub.id, {
            discounts: [{ coupon: offer.couponId }],
          })
        } else {
          // Release any pending schedule so the coupon attaches cleanly, then
          // attach it and clear any pending cancel in one update.
          await releaseScheduleIfAny(stripe, sub, env)
          updated = await stripe.subscriptions.update(sub.id, {
            discounts: [{ coupon: offer.couponId }],
            cancel_at_period_end: false,
          })
        }
        if (env.DATABASE_URL) {
          try {
            await insertCancellationSurvey(getDb(env), {
              email,
              reasons: [],
              note: null,
              offerOutcome: 'accepted',
              couponId: offer.couponId,
            })
          } catch (err) {
            console.error('[stripe] accept-save-offer survey write failed:', err)
          }
        }

        json(200, {
          ok: true,
          kind: offer.kind,
          percentOff: offer.percentOff,
          amountOff: offer.amountOff,
          durationMonths: offer.durationMonths,
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
        const hasSchedule = Boolean(sub && scheduleIdOf(sub))
        // The tier a pending period-end change lands on (e.g. a debundle's
        // bundle → ark-plus), read from the Neon row by the sub's customer, so the
        // account page can name the change rather than say "a plan change".
        let scheduledTier: string | null = null
        if (hasSchedule && sub && env.DATABASE_URL) {
          try {
            scheduledTier = await getScheduledTierByCustomer(
              getDb(env),
              customerIdOf(sub),
            )
          } catch (err) {
            console.error('[stripe] my-subscription scheduled-tier read failed:', err)
          }
        }
        json(200, {
          cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
          cancelAt,
          // A schedule-managed sub has a pending period-end tier/PWYC change
          // (task 14). The account page can surface "a plan change is scheduled".
          pendingChange: hasSchedule,
          // The tier that change lands on, so the page can say "bundle → Ark+".
          // Null when nothing is scheduled (or the row is unreadable).
          scheduledTier,
          // The current period end — the date any pending change / debundle takes
          // effect and through which access continues. Lets the account page show
          // a concrete date instead of "the end of your current billing period".
          periodEnd: sub ? periodEndIso(sub) : null,
          // Billing cadence, so the cancel flows can branch copy by monthly vs
          // annual (Flow A / Flow D). Null when there's no live sub.
          plan: sub ? planFromSubscription(sub) : null,
        })
      },
    }),

    defineRoute({
      // Prices for the bundle "keep any services?" selector (Flows C/D/E entry):
      // the current bundle price + each product's standalone price, for the
      // member's cadence. Fails closed to null so the selector can still render
      // its checkboxes (just without the price/total lines) on a Stripe hiccup.
      path: '/api/stripe/bundle-breakdown',
      method: 'GET',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findLiveSubscription(stripe, email)
        const plan = sub ? planFromSubscription(sub) : null
        if (!plan) return json(200, { breakdown: null })

        try {
          const breakdown = await bundleBreakdown(stripe, plan)
          return json(200, { breakdown })
        } catch (err) {
          console.error('[stripe] bundle-breakdown failed:', err)
          return json(200, { breakdown: null })
        }
      },
    }),

    defineRoute({
      // The mirror of bundle-breakdown, for the other direction: what happens
      // to a single-axis member's subscription when they add the axis they
      // don't have. The account page needs it to say the switch out loud before
      // it bills — the Bundle price REPLACES what they pay now, it is not a
      // second charge beside it — and to name the date they'll still renew on.
      // Amounts come back in the SUBSCRIPTION's currency, which is the one that
      // will actually be charged (change-tier bills in sub.currency, not the
      // page's geo-detected one).
      //
      // Fails soft: `preview: null` only when there's no live sub to change; a
      // price-lookup hiccup leaves `bundleCents: null` so the confirm step can
      // still render (and still let the member proceed) without price lines.
      path: '/api/stripe/bundle-upgrade-preview',
      method: 'GET',
      handler: async (req, _res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findLiveSubscription(stripe, email)
        const plan = sub ? planFromSubscription(sub) : null
        if (!sub || !plan) return json(200, { preview: null })

        const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'
        // `unit_amount` is stated in the PRICE's own currency. A catalog price
        // billed through currency_options reports the USD base here while the
        // subscription charges the localized amount — quoting that as "what you
        // pay now" would be wrong money, so only trust it when the currencies
        // agree and drop the line otherwise.
        const price = sub.items.data[0]?.price
        const currentCents =
          price && price.currency === sub.currency && typeof price.unit_amount === 'number'
            ? price.unit_amount
            : null

        let bundleCents: number | null = null
        try {
          const catalog = await resolveCatalogPrice(stripe, 'bundle', plan)
          bundleCents = catalog.floors[currency] ?? catalog.floors.usd
        } catch (err) {
          console.error('[stripe] bundle-upgrade-preview price lookup failed:', err)
        }

        return json(200, {
          preview: {
            plan,
            currency,
            minorFactor: minorUnitFactors()[currency] ?? 100,
            currentCents,
            bundleCents,
            // Unchanged by the switch: gaining an entitlement updates the item
            // in place and only re-anchors the cycle on a cadence change, so
            // this is still the member's renewal date afterwards.
            renewsAt: periodEndIso(sub),
          },
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
            retained_product?: unknown
            offer_outcome?: unknown
          }>(req)) ?? {}
        if (body.plan !== 'monthly' && body.plan !== 'yearly') {
          return json(400, { error: 'plan must be "monthly" or "yearly"' })
        }
        // A debundle (bundle → single product) passes retained_product so the
        // win-back record captures what was kept; a plain upgrade/PWYC omits it.
        const retainedProduct = isRetainedProduct(body.retained_product)
          ? body.retained_product
          : null
        // Whether a save offer was shown-and-declined before the debundle, so
        // the win-back row records 'declined' vs 'not_offered' the same way the
        // full-cancel path does. Defaults to not_offered for a plain change.
        const debundleOutcome = isCancelOfferOutcome(body.offer_outcome)
          ? body.offer_outcome
          : 'not_offered'
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

        const currentTier = await tierFromSubscription(sub, stripe)
        // Unbundling settles at the kept product's own catalog price: the bundle
        // is a discount on two standalone prices, and splitting it forfeits that.
        // The softer landing is a bounded intro coupon on the scheduled phase
        // (below), not a permanently reduced price. Gated on the subscription
        // really being a bundle, and never member-chosen — a debundle takes the
        // catalog floor, so PWYC can't be smuggled in via retained_product.
        const isDebundle =
          retainedProduct !== null && currentTier === 'bundle' && newTier !== 'bundle'
        let amountCents: number
        if (isDebundle) {
          amountCents = floor
        } else {
          const pwyc = validatePwycAmount(body.custom_amount_cents, floor, currency)
          if ('error' in pwyc) return json(400, { error: pwyc.error })
          amountCents = pwyc.amountCents
        }

        // The intro coupon rides the *scheduled phase*, not the subscription, so
        // its clock starts when the new price does. Attaching it now would burn
        // the term against the bundle the member is still on — up to a full
        // billing period before the product it discounts exists.
        //
        // It is a retention discount like any other, so it spends the same
        // once-per-12-months budget the save offers do. Without this check a
        // member could debundle, re-bundle, and debundle again to collect the
        // intro rate indefinitely — the accept-window guard only covered
        // /accept-save-offer. On a DB error, treat the window as spent: skipping
        // a discount is recoverable, granting an unlimited one isn't.
        let introCoupon: Awaited<ReturnType<typeof pickIntroCoupon>> | null = null
        if (isDebundle) {
          let windowSpent = true
          if (env.DATABASE_URL) {
            try {
              windowSpent = await hasAcceptedRetention(getDb(env), email)
            } catch (err) {
              console.error('[stripe] debundle intro eligibility check failed:', err)
            }
          } else {
            windowSpent = false
          }
          if (!windowSpent) introCoupon = pickIntroCoupon(await listActiveCoupons(stripe))
        }

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

        // Win-back record for a debundle (retained_product set): the member is
        // leaving one product but keeping another. Records the tier left, what
        // was kept, and whether a save offer was declined first, joinable to
        // Beehiiv by email. Recorded on whichever branch the change lands — a
        // debundle is loss-of-entitlement so it is normally period-end, but this
        // stays correct if that ever changes. Non-blocking — a failed analytics
        // write must never fail the debundle. No-op for a plain upgrade/PWYC.
        //
        // When an intro coupon was granted this row is also what SPENDS the
        // 12-month retention window: hasAcceptedRetention only counts rows with
        // a non-null coupon_id and outcome 'accepted', so writing null here (as
        // it previously did) left the discount invisible to the eligibility read
        // and therefore repeatable.
        const recordDebundleWinBack = async () => {
          if (!retainedProduct || !env.DATABASE_URL) return
          try {
            await insertCancellationSurvey(getDb(env), {
              email,
              reasons: [],
              note: null,
              offerOutcome: introCoupon ? 'accepted' : debundleOutcome,
              couponId: introCoupon?.id ?? null,
              canceledTier: currentTier,
              retainedProduct,
            })
          } catch (err) {
            console.error('[stripe] debundle survey write failed:', err)
          }
        }

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
            await recordDebundleWinBack()
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
              {
                items: [{ ...destinationPrice, quantity: 1 }],
                // Phase-scoped so the intro term is measured from the moment the
                // debundled price takes effect. A repeating N-month coupon then
                // discounts every invoice inside that window: N monthly invoices,
                // but only the one annual invoice — so an annual debundler gets a
                // full discounted year. Intended, and what the quote promises.
                ...(introCoupon ? { discounts: [{ coupon: introCoupon.id }] } : {}),
              },
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
          await recordDebundleWinBack()
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
