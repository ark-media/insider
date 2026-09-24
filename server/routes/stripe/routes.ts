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
//   GET  /api/stripe/my-subscription       — the signed-in member's cancel
//     schedule, price and card on file, for the account page's plan card.
//   POST /api/stripe/card-setup-intent     — a SetupIntent that mounts Stripe's
//     Payment Element on the billing page, to collect a replacement card.
//   POST /api/stripe/update-card           — make that confirmed card the one
//     the membership is billed to.
//   GET  /api/stripe/bundle-upgrade-preview — what a single-axis member's
//     subscription becomes when they add the other axis: the Bundle price that
//     REPLACES their current one, and the renewal date that doesn't move.
//   POST /api/stripe/webhook               — server-to-server signal from
//     Stripe; the source of truth for membership + entitlement state.

import type Stripe from 'stripe'
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
  discountsSurvivingChange,
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
import { listActiveCoupons } from '../../lib/stripe-promos.js'
import { welcomeDiscountActive } from '../../lib/welcome-offer.js'
import { membershipRowsForEmail } from '../../lib/entitlement-resolver.js'
import {
  formatMinorUnits,
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
import { createSharedRateLimiter } from '../../lib/shared-rate-limit.js'
import { getSessionEmail, resolveRequestIdentity } from '../../lib/session.js'
import { requireBillingEmail } from '../../lib/guards.js'
import { sendEmail } from '../../lib/email.js'
import {
  renderCancellationEmail,
  renderDebundleEmail,
  type CancellableTier,
} from '../../lib/cancellation-email.js'
import {
  EMAIL_TIME_ZONE,
  formatTimestampInZone,
} from '../../../shared/format-date.js'
import { isValidEmail } from '../../../shared/validation.js'
import { defineRoute, type Deps, type Route } from '../../lib/route.js'
import {
  addCouponToFinalPhase,
  cardOf,
  changeIsImmediate,
  coerceTier,
  customerIdOf,
  existingDiscountParams,
  findLiveSubscription,
  findOrCreateSubscriber,
  giftExtensionRunning,
  MAX_NAME_LEN,
  oneCycleFromNowIso,
  periodEndIso,
  phaseDiscountParams,
  planFromSubscription,
  quoteChargeToday,
  readCardOnFile,
  releaseScheduleIfAny,
  scheduledPlanOf,
  scheduleIdOf,
  subscriptionAmount,
  tsToIso,
  validatePwycAmount,
} from './helpers.js'
import {
  catalogTierOfSubscription,
  dispatchWebhookEvent,
  saveFlowTargetOf,
  tierFromSubscription,
} from './webhook.js'

// How long a webhook claim is honoured before another delivery may take it over.
// The function's maxDuration is 60s, so by two minutes a 'processing' claim
// belongs to an invocation that no longer exists.
const WEBHOOK_CLAIM_LEASE_SEC = 120

// Log the missing-migration fallback once per instance, not once per event.
let warnedLedgerLeaseMissing = false

// Postgres 42703 undefined_column — what the leased claim raises against a
// ledger that predates migration 0004.
function isUndefinedColumn(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  if (e?.code === '42703') return true
  return typeof e?.message === 'string' && /column .* does not exist/i.test(e.message)
}

// A Stripe error that means "the payment didn't go through" (a decline, or a
// card that needs an authentication step this server-side update can't present)
// rather than "the request was wrong" or "Stripe is down".
function isCardPaymentError(err: unknown): boolean {
  const e = err as { type?: unknown; statusCode?: unknown } | null
  return e?.type === 'StripeCardError' || e?.statusCode === 402
}

export function stripeRoutes({ env, stripe, appBaseUrl, activator }: Deps): Route[] {
  // Per-email cap on Checkout Session creation. Mirrors the gift flow: a
  // scripted caller can't produce thousands of zombie Sessions / Customer
  // rows. Small enough to catch abuse and large enough that a real buyer
  // retrying a few times doesn't get blocked.
  //
  // The three unauthenticated limiters here (both checkout buckets and the
  // consent one) are SHARED — one Neon row per bucket — because the in-memory
  // kind gives every function instance its own allowance, which multiplies the
  // limit on exactly the routes anyone can script. The session-authenticated
  // ones below stay in memory: their caller is a known, paying member.
  const subscribeLimiter = createSharedRateLimiter(env, {
    name: 'stripe-checkout-email',
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })
  // Keying only on the submitted email let a caller reset the bucket by
  // changing it — which mattered twice over, because this endpoint both writes
  // to Stripe (customer + session) and answers "is this address a member?".
  // The per-IP bucket is what actually bounds enumeration. Vercel overwrites
  // x-forwarded-for with the true client IP, so it can't be spoofed in prod.
  const subscribeIpLimiter = createSharedRateLimiter(env, {
    name: 'stripe-checkout-ip',
    capacity: 15,
    refillPerSec: 15 / (60 * 60), // 15 per hour per source
  })
  // Per-member cap on subscription changes. Unlike the checkout routes this one
  // is session-authenticated, so the risk isn't enumeration — it's cost: every
  // call fans out to several Stripe reads before it can decide anything, and a
  // client looping on a request the server refuses still pays for them. Keyed on
  // the session email, which a caller can't rotate by editing the body.
  // Generous enough that a member walking a cancel/debundle flow, changing their
  // mind and retrying a failed switch never meets it.
  const changeTierLimiter = createRateLimiter({
    capacity: 20,
    refillPerSec: 20 / (60 * 60), // 20 per hour
  })
  // Per-IP cap on consent writes. One purchase needs one call, and a retried
  // payment a handful; anything past that is a caller spending our Stripe
  // request budget on an endpoint that answers nothing useful.
  const consentLimiter = createSharedRateLimiter(env, {
    name: 'stripe-consent-ip',
    capacity: 30,
    refillPerSec: 30 / (60 * 60), // 30 per hour per source
  })
  // Per-member cap on card-update SetupIntents. A form that saves a card
  // without charging it is the classic card-testing surface, and while this one
  // sits behind a paid membership, nobody replacing their own card needs more
  // than a few tries an hour — a typo'd number and a declined card included.
  const cardSetupLimiter = createRateLimiter({
    capacity: 10,
    refillPerSec: 10 / (60 * 60), // 10 per hour
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

        const plan = body.plan
        const interval: 'month' | 'year' = plan === 'monthly' ? 'month' : 'year'
        const tier = coerceTier(body.tier)

        // Rate-limit after input validation so a clearly-malformed request
        // doesn't consume a token from a legitimate retry.
        const clientIp = getClientIp(req)
        const wait =
          (await subscribeIpLimiter.take(clientIp)) ??
          (await subscribeLimiter.take(`${clientIp}|${email}`))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, {
            error: 'Too many checkout attempts. Please wait a moment and try again.',
          })
        }

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

        // The email above is whatever the buyer typed — nothing has proven it
        // is theirs. Two things downstream would otherwise treat it as proof:
        // the webhook upserts the membership row `on conflict (auth0_sub)`, and
        // the Customer lookup below reuses an existing Customer. So work out
        // once whether this request is a DURABLE login as that same address
        // ('auth0' — the checkout token is itself minted off a typed email, so
        // it proves nothing here).
        const identity = await resolveRequestIdentity(req, env)
        const provenEmail =
          identity?.source === 'auth0' && identity.email.trim().toLowerCase() === email

        // Existing-account guard. An address that already has a membership row
        // — a comped staffer, an early-access member, a gift recipient — must
        // sign in before buying: an anonymous purchase under it would overwrite
        // their comp/gift row with the buyer's subscription, and the eventual
        // subscription.deleted would then take the row away altogether. Fails
        // CLOSED: if we can't check, we don't sell. Without a database there are
        // no rows to protect.
        if (env.DATABASE_URL && !provenEmail) {
          let hasRow: boolean
          try {
            hasRow = (await membershipRowsForEmail(env, stripe, email)).length > 0
          } catch (err) {
            console.error('[stripe] checkout existing-account check failed:', err)
            return json(502, { error: 'Could not start checkout. Please try again.' })
          }
          if (hasRow) {
            return json(409, {
              error: 'You already have an Ark account. Sign in to change or add to your plan.',
              code: 'login_required',
            })
          }
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

        // Find-or-reuse a customer so a signed-in member doesn't mint duplicates
        // for their own email (and so the resulting subscription's customer
        // always has an email). Reuse is for a PROVEN email only — an existing
        // Customer carries a saved card, a balance and a billing history, none
        // of which belong to whoever typed the address. Everyone else gets a
        // fresh Customer; one email mapping to several is already a fact of life
        // here (churn-then-resubscribe) and every lookup copes with it.
        const customer = await findOrCreateSubscriber(stripe, {
          email,
          name: body.name,
          reuseExisting: provenEmail,
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
          // the Customer, that null was what made Auth0, Circle and every
          // welcome email fall back to the email local part.
          customer_update: { address: 'auto', name: 'auto' },
          // Let the buyer redeem a promotion code in the modal, and let the
          // house sale ride the same rail: this is exclusive with a server-set
          // `discounts` array (Stripe: "You may only specify one of these
          // parameters"), so the sale is applied client-side by code too —
          // /api/promo/active hands the browser the code to apply, and Stripe
          // validates every code, ours included, at redemption.
          allow_promotion_codes: true,
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
      // whose id the caller already had, and only once — both enforced below,
      // not assumed of Stripe.
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

        const wait = await consentLimiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'Too many requests.' })
        }

        // Look before writing. The comment above used to lean on Stripe to
        // refuse a write to a finished Session; it doesn't — metadata stays
        // writable after completion — so anyone holding a `cs_` id could rewrite
        // the consent record of a PAID purchase, which is precisely the evidence
        // a dispute turns on. Two rules, both checked against the Session as
        // Stripe holds it:
        //   - only an OPEN Session takes consent (the browser records it just
        //     before confirming, never after);
        //   - consent is written ONCE. A retried payment posts again; the first
        //     acceptance stands and the repeat is acked without a write, so the
        //     record can't be replaced by a later caller either.
        let existing: Stripe.Checkout.Session
        try {
          existing = await stripe.checkout.sessions.retrieve(sessionId)
        } catch (err) {
          console.error('[stripe] consent: session lookup failed for', sessionId, err)
          return json(502, { error: 'Could not record consent.' })
        }
        if (existing.status !== 'open') {
          return json(409, { error: 'This checkout is no longer open.' })
        }
        if (existing.metadata?.[CONSENT_ACCEPTED_AT_KEY]) {
          return json(200, { ok: true, already_recorded: true })
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
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        // Signed in for real, not merely holding an emailed link (guards.ts).
        const cancelEmail = await requireBillingEmail(req, res, env)
        if (!cancelEmail) return

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
        // Derived outside the DB block because the confirmation email needs it
        // too — which tier is being left decides the whole body of that email,
        // and a Stripe-only preview env still sends it.
        let canceledTier: string | null = null
        try {
          canceledTier = await tierFromSubscription(sub, stripe)
        } catch (err) {
          console.error('[stripe] cancel: tier derivation failed:', err)
        }

        let surveyId: string | number | null = null
        if (env.DATABASE_URL) {
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

        const accessUntilIso = periodEndIso(sub)

        // The confirmation email. Sent HERE rather than off
        // customer.subscription.deleted, which is the other obvious hook and the
        // wrong one: `.deleted` doesn't fire until the period actually ends,
        // weeks later, by which time "you'll keep your benefits through <date>"
        // is a sentence about the past. The member needs it now, at the moment
        // they pressed the button.
        //
        // Strictly best-effort, and after the cancel has committed: a mail
        // failure must never turn into "we couldn't cancel you". sendEmail
        // already soft-fails, and the try/catch covers everything around it.
        if (canceledTier && canceledTier !== 'free') {
          try {
            const identity = await resolveRequestIdentity(req, env)
            const { subject, html } = renderCancellationEmail({
              firstName: identity?.firstName ?? undefined,
              tier: canceledTier as CancellableTier,
              accessUntil:
                formatTimestampInZone(accessUntilIso, EMAIL_TIME_ZONE, 'long', {
                  withZoneLabel: true,
                }) || null,
              // [FEEDBACK LINK PLACEHOLDER]. The structured reasons survey is
              // collected in-app right after this call returns; this is the
              // second chance for someone who skipped it, so it goes to the
              // desk a human reads rather than a form that needs a session.
              feedbackUrl: `${appBaseUrl}/contact?topic=general`,
              accountUrl: `${appBaseUrl}/account/billing`,
            })
            // Keyed on the subscription AND the date access ends, so a
            // double-submit collapses while a cancel → reactivate → cancel
            // still confirms the second time.
            const sent = await sendEmail(env, {
              to: cancelEmail,
              subject,
              html,
              idempotencyKey: `cancel_${sub.id}_${accessUntilIso ?? 'na'}`,
            })
            if (!sent) {
              console.error('[email] cancellation email did not send:', sub.id)
            }
          } catch (err) {
            console.error('[email] cancellation email failed:', err)
          }
        }

        json(200, { ok: true, access_until: accessUntilIso, survey_id: surveyId })
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
      // burns no eligibility — it's a plain resume. Nothing needs mirroring
      // downstream: the Beehiiv grant is a boolean tier with no cancel schedule
      // of its own, so clearing Stripe's is the whole operation.
      path: '/api/stripe/reactivate-subscription',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        // Signed in for real, not merely holding an emailed link (guards.ts).
        const email = await requireBillingEmail(req, res, env)
        if (!email) return

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })

        // Resume the current plan: drop any pending period-end change (schedule)
        // and clear a pending cancel. Update Stripe only when there's actually
        // something to undo — a pending downgrade (schedule) or a pending cancel
        // — so a plain reactivate on an already-renewing sub stays a no-op.
        const hadSchedule = Boolean(scheduleIdOf(sub))
        await releaseScheduleIfAny(stripe, sub, env)

        // Releasing a schedule abandons the change it carried, and a retention
        // coupon may have been accepted ON that change: the annual→monthly save
        // attaches the monthly supporter rate beside the scheduled switch. With
        // the switch gone the subscription stays on its current plan, and the
        // coupon would take its monthly-priced cut off an annual invoice. Drop
        // any retention discount that doesn't fit the plan/tier being resumed.
        // A tier we can't read drops nothing on that axis.
        let survivingDiscounts: Awaited<ReturnType<typeof discountsSurvivingChange>> = null
        if (hadSchedule) {
          const resumedTier = await catalogTierOfSubscription(sub, stripe).catch(() => null)
          survivingDiscounts = await discountsSurvivingChange(stripe, sub, {
            tier: resumedTier,
            plan: planFromSubscription(sub),
          })
        }
        const updated =
          sub.cancel_at_period_end || hadSchedule
            ? await stripe.subscriptions.update(sub.id, {
                cancel_at_period_end: false,
                ...(survivingDiscounts !== null ? { discounts: survivingDiscounts } : {}),
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
        // Quote in what the subscription bills in, not the USD base.
        const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'

        let offers
        // For a debundle, the standalone price the *kept* product continues at,
        // shown on the confirm screen (Flows C/D/E). Null for a full cancel.
        let standalone = null
        try {
          // Offers for where the subscription is headed (saveFlowTargetOf), and
          // only for an intent that tier can open — the same gate
          // accept-save-offer applies, so nothing is offered that accepting
          // would then refuse.
          const target = await saveFlowTargetOf(sub, stripe)
          const plan = target.plan
          if (!plan || !target.tier || !intentAllowedForTier(intent, target.tier)) {
            return json(200, empty)
          }
          offers = await deriveSaveOffers(stripe, intent, plan, currency)
          // Accepting the annual switch calls change-tier with the flow's tier
          // at yearly, catalog price. change-tier decides its timing against
          // the LIVE subscription, so this does too: normally that's a switch
          // charged today that restarts the cycle, and the card quotes the
          // charge. With a debundle booked, the flow's tier is the one being
          // moved to — the switch then loses an entitlement and lands at
          // period end, so there is nothing to charge today and the card says
          // when it starts instead.
          const tier = coerceTier(target.tier)
          offers = await Promise.all(
            offers.map(async (o) => {
              if (o.kind !== 'annual_switch') return o
              // A quote that fails drops the figure, never the offer.
              try {
                const yearly = await resolveCatalogPrice(stripe, tier, 'yearly')
                const liveTier = target.scheduled
                  ? await catalogTierOfSubscription(sub, stripe)
                  : tier
                const livePrice = sub.items.data[0]?.price
                const liveAmount = livePrice
                  ? await subscriptionAmount(stripe, sub, livePrice)
                  : null
                const immediate =
                  liveTier !== null &&
                  changeIsImmediate(
                    deriveEntitlements(liveTier),
                    deriveEntitlements(tier),
                    liveAmount,
                    yearly.floors[currency] ?? yearly.floors.usd,
                  )
                if (!immediate) return { ...o, dueTodayCents: null, startsAt: periodEndIso(sub) }
                return {
                  ...o,
                  dueTodayCents: await quoteChargeToday(stripe, sub, yearly.priceId, {
                    tier,
                    plan: 'yearly',
                  }),
                }
              } catch (err) {
                console.error('[stripe] annual-switch quote failed:', err)
                return { ...o, dueTodayCents: null }
              }
            }),
          )
          if (intent === 'debundle-remove-ark-plus') {
            standalone = await debundlePricePreview(stripe, 'circle', plan, currency)
          } else if (intent === 'debundle-remove-circle') {
            standalone = await debundlePricePreview(stripe, 'ark-plus', plan, currency)
          }
        } catch (err) {
          console.error('[stripe] save-offers derivation failed:', err)
          return json(200, empty)
        }

        // Window-suppress promotional coupons (keep plan switches). A read
        // failure fails closed: drop coupon offers rather than risk a repeat.
        // A member still on the welcome offer's price is suppressed the same
        // way — the coupons are quoted off the list price, and stacking one on
        // the welcome discount would quote a number they won't be charged.
        {
          let blocked = welcomeDiscountActive(sub.metadata)
          if (!blocked && env.DATABASE_URL) {
            blocked = true
            try {
              blocked = await hasAcceptedRetention(getDb(env), email)
            } catch (err) {
              console.error('[stripe] save-offers eligibility check failed:', err)
            }
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
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        // Signed in for real, not merely holding an emailed link (guards.ts).
        const email = await requireBillingEmail(req, res, env)
        if (!email) return

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
        // lands another product's coupon on their own subscription. "Actual" is
        // where the subscription is headed (saveFlowTargetOf), the same tier
        // save-offers quoted from: a bundle member with a debundle booked is
        // cancelling the product they're keeping.
        const target = await saveFlowTargetOf(sub, stripe)
        if (!target.tier || !target.plan || !intentAllowedForTier(body.intent, target.tier)) {
          return json(409, { error: 'No such save offer available.' })
        }

        // A plan-switch offer is quoted to the cadence being LEFT (monthly_switch
        // only exists for a yearly member), but by now change-tier has booked the
        // switch, so the target reads the new cadence. Derive at the old one;
        // the plan-switch branch below still refuses unless the switch landed.
        const derivePlan =
          wantKind === 'monthly_switch'
            ? 'yearly'
            : wantKind === 'annual_switch'
              ? 'monthly'
              : target.plan

        // Derived in the subscription's currency, so a fixed-amount coupon that
        // doesn't carry that currency is never picked — Stripe would refuse to
        // attach it.
        const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'
        const offers = await deriveSaveOffers(stripe, body.intent, derivePlan, currency)

        const offer = offers.find((o) => o.kind === wantKind && o.couponId)
        // A pure plan switch (annual_switch, no coupon) is applied via
        // change-tier, not here — nothing to attach.
        if (!offer || !offer.couponId) {
          return json(409, { error: 'No such save offer available.' })
        }

        // Never on top of the welcome offer's price while it runs (see
        // save-offers, which doesn't offer it).
        if (welcomeDiscountActive(sub.metadata)) {
          return json(409, { error: 'Save offer not available on your welcome price.' })
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

        const pendingScheduleId = target.scheduled ? scheduleIdOf(sub) : null
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
          const scheduleId = scheduleIdOf(sub)
          if (plan !== target && scheduleId) {
            // The switch is still a future phase. Stripe won't take a discount
            // update on a schedule-managed subscription, and the coupon belongs
            // to the cadence being switched TO anyway — so it goes on that phase,
            // where its clock starts with the new price. Every phase is passed
            // back with its own discounts, since the update replaces them all.
            await addCouponToFinalPhase(stripe, scheduleId, offer.couponId)
            updated = sub
          } else {
            // Already on the target cadence: attach to the subscription, keeping
            // whatever it already carries.
            updated = await stripe.subscriptions.update(sub.id, {
              discounts: [...existingDiscountParams(sub), { coupon: offer.couponId }],
            })
          }
        } else if (pendingScheduleId) {
          // The offer was derived for the pending phase (a booked debundle, say),
          // so the coupon goes there: releasing the schedule would cancel the
          // change the member already made and leave the coupon discounting a
          // product it wasn't priced for. Its clock starts with that phase.
          await addCouponToFinalPhase(stripe, pendingScheduleId, offer.couponId)
          updated = sub
        } else {
          // Release any pending schedule so the coupon attaches cleanly, then
          // attach it and clear any pending cancel in one update. Existing
          // discounts are passed back alongside it: `discounts` replaces the
          // whole list, and accepting a save must never quietly strip a promo
          // the member already had (a forever checkout code, say).
          await releaseScheduleIfAny(stripe, sub, env)
          updated = await stripe.subscriptions.update(sub.id, {
            discounts: [...existingDiscountParams(sub), { coupon: offer.couponId }],
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

        // The one caller that reads the card on file, so the one that asks for
        // the payment method to ride along on the list.
        const sub = await findLiveSubscription(stripe, email, { withPaymentMethod: true })
        // When cancel_at_period_end is set, Stripe populates cancel_at; fall back
        // to the current period end so we always have a date to show.
        let cancelAt: string | null = null
        if (sub?.cancel_at_period_end) {
          cancelAt = tsToIso(sub.cancel_at) ?? periodEndIso(sub)
        }
        const hasSchedule = Boolean(sub && scheduleIdOf(sub))
        // What the member actually pays, for the account page's plan card.
        const price = sub?.items?.data?.[0]?.price
        const amountCents = sub && price ? await subscriptionAmount(stripe, sub, price) : null
        const currency = sub ? sub.currency : null
        const minorFactor =
          currency && isSupportedCurrency(currency) ? (minorUnitFactors()[currency] ?? 100) : 100

        // The card on file, so the plan card can say "Visa ending 4242" rather
        // than send the member to Stripe to find out. Read from the
        // subscription's own default first, then the customer's invoice
        // default, which is what Stripe charges when the sub names none.
        // Best-effort: a failure here just drops the line.
        const card = sub ? await readCardOnFile(stripe, sub) : null
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
          // And the cadence it lands on, so a cancel flow opened on the pending
          // tier quotes that tier's cadence. Null when nothing is scheduled.
          scheduledPlan: hasSchedule && sub ? await scheduledPlanOf(stripe, sub) : null,
          // The current period end — the date any pending change / debundle takes
          // effect and through which access continues. Lets the account page show
          // a concrete date instead of "the end of your current billing period".
          periodEnd: sub ? periodEndIso(sub) : null,
          // Billing cadence, so the cancel flows can branch copy by monthly vs
          // annual (Flow A / Flow D). Null when there's no live sub.
          plan: sub ? planFromSubscription(sub) : null,
          // What the next bill is, in its own currency + minor units, so the
          // account page can render it without a second round trip. Null when
          // there's no live sub or the amount can't be quoted honestly.
          amountCents,
          currency,
          minorFactor,
          // { brand, last4, expMonth, expYear } or null.
          card,
        })
      },
    }),

    defineRoute({
      // Step one of replacing the card on file, on the billing page itself: a
      // SetupIntent on the member's Stripe customer, whose client secret mounts
      // the Payment Element. Confirming it saves the card and charges nothing;
      // /api/stripe/update-card below is what points the membership at it.
      //
      // Cards only. The account page can only describe a card ("Visa ending
      // 4242"), and a bank debit would bring a mandate and a redirect that this
      // flow has no return leg for.
      path: '/api/stripe/card-setup-intent',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        // Signed in for real, not merely holding an emailed link (guards.ts).
        const email = await requireBillingEmail(req, res, env)
        if (!email) return

        const wait = cardSetupLimiter.take(email)
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, {
            error: 'Too many attempts in a row. Please wait a few minutes and try again.',
          })
        }

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })

        try {
          const intent = await stripe.setupIntents.create({
            customer: customerIdOf(sub),
            payment_method_types: ['card'],
            usage: 'off_session',
            metadata: { kind: 'card_update', subscription: sub.id },
          })
          return json(200, { clientSecret: intent.client_secret })
        } catch (err) {
          console.error('[stripe] card-setup-intent failed:', err)
          return json(502, { error: 'Could not open the card form. Please try again.' })
        }
      },
    }),

    defineRoute({
      // Step two: bill the membership to the card the member just confirmed.
      //
      // The body names only the SetupIntent, never a payment method, and the
      // card is read off that intent after checking it belongs to the session
      // member's own customer and actually succeeded. So a caller can't point
      // someone's membership at a card they didn't just save, or at a card
      // belonging to another customer.
      //
      // Three places name the card Stripe charges, and all three move:
      //   - the subscription's default_payment_method, which Checkout set to the
      //     original card and which wins while it's set;
      //   - the customer's invoice default, the fallback when nothing else names
      //     one;
      //   - a pending change's schedule. Creating a schedule copies the
      //     subscription's card into the schedule's default_settings, and Stripe
      //     re-applies that to the subscription when the change lands — so
      //     without this, a member with a debundle pending would be switched back
      //     to the old card on the very date they're next charged.
      //
      // Every write is idempotent, so a member whose save failed partway can
      // retry with the same intent and land in the same place.
      path: '/api/stripe/update-card',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        // Signed in for real, not merely holding an emailed link (guards.ts).
        const email = await requireBillingEmail(req, res, env)
        if (!email) return

        const body = (await readJson<{ setup_intent_id?: unknown }>(req)) ?? {}
        const setupIntentId = body.setup_intent_id
        if (typeof setupIntentId !== 'string' || !setupIntentId.startsWith('seti_')) {
          return json(400, { error: 'setup_intent_id is required.' })
        }

        const sub = await findLiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })
        const customerId = customerIdOf(sub)

        let intent: Stripe.SetupIntent
        try {
          intent = await stripe.setupIntents.retrieve(setupIntentId, {
            expand: ['payment_method'],
          })
        } catch {
          return json(404, { error: 'That card could not be found. Please try again.' })
        }
        const intentCustomer =
          typeof intent.customer === 'string' ? intent.customer : intent.customer?.id
        // Same answer as a missing intent: whether an id belongs to someone
        // else is not something to confirm to the caller.
        if (intentCustomer !== customerId) {
          return json(404, { error: 'That card could not be found. Please try again.' })
        }
        const pm = intent.payment_method
        if (intent.status !== 'succeeded' || !pm) {
          return json(409, { error: 'That card has not been confirmed yet. Please try again.' })
        }
        const pmId = typeof pm === 'string' ? pm : pm.id

        try {
          const scheduleId = scheduleIdOf(sub)
          if (scheduleId) {
            await stripe.subscriptionSchedules.update(scheduleId, {
              default_settings: { default_payment_method: pmId },
            })
          }
          await stripe.subscriptions.update(sub.id, { default_payment_method: pmId })
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: pmId },
          })
        } catch (err) {
          console.error('[stripe] update-card failed:', err)
          return json(502, {
            error: 'Your card was saved, but we could not switch your membership to it. Please try again.',
          })
        }

        json(200, { ok: true, card: typeof pm === 'string' ? null : cardOf(pm) })
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
        if (!sub || !plan) return json(200, { breakdown: null })
        const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'

        try {
          const breakdown = await bundleBreakdown(stripe, plan, currency)
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
        // What the member pays today, in their own currency — see
        // subscriptionAmount. Dropping the line for everyone outside the base
        // currency was worse here than on the plan card: `bundleCents` below IS
        // localized, so a non-USD member was shown what the Bundle costs with
        // nothing to compare it against, which is the entire point of a preview.
        const price = sub.items.data[0]?.price
        const currentCents = price ? await subscriptionAmount(stripe, sub, price) : null

        let bundleCents: number | null = null
        let bundlePriceId: string | null = null
        try {
          const catalog = await resolveCatalogPrice(stripe, 'bundle', plan)
          bundleCents = catalog.floors[currency] ?? catalog.floors.usd
          bundlePriceId = catalog.priceId
        } catch (err) {
          console.error('[stripe] bundle-upgrade-preview price lookup failed:', err)
        }

        // What comes off the card today — change-tier re-anchors the cycle on
        // this switch. Null when it can't be quoted; the panel then says what
        // happens without the figure.
        const dueTodayCents = bundlePriceId
          ? await quoteChargeToday(stripe, sub, bundlePriceId, { tier: 'bundle', plan })
          : null

        return json(200, {
          preview: {
            plan,
            currency,
            minorFactor: minorUnitFactors()[currency] ?? 100,
            currentCents,
            bundleCents,
            dueTodayCents,
            // The switch re-anchors the cycle to today, so the member renews
            // one full period from now — not on their current renewal date.
            renewsAt: oneCycleFromNowIso(plan),
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
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })

        // Signed in for real, not merely holding an emailed link (guards.ts).
        const email = await requireBillingEmail(req, res, env)
        if (!email) return

        const body =
          (await readJson<{
            tier?: string
            plan?: 'monthly' | 'yearly'
            custom_amount_cents?: number
            retained_product?: unknown
            offer_outcome?: unknown
            age_statement?: unknown
          }>(req)) ?? {}
        if (body.plan !== 'monthly' && body.plan !== 'yearly') {
          return json(400, { error: 'plan must be "monthly" or "yearly"' })
        }

        // After the free validation above, before the first Stripe call below.
        const changeWait = changeTierLimiter.take(email)
        if (changeWait !== null) {
          res.setHeader('retry-after', String(changeWait))
          return json(429, {
            error: 'Too many changes in a row. Please wait a moment and try again.',
          })
        }
        // The 18+ sentence the member ticked when this change is what puts them
        // in the Fold (src/components/account/BundleConfirm). Recorded, not
        // enforced: the browser is what requires the tick, and this route does
        // not refuse a change that arrives without one — an upgrade is not the
        // place to discover a member can no longer use their own membership.
        //
        // Stamped on the subscription because that is the only durable Stripe
        // object this route touches; the checkout paths use their Checkout
        // Session, under the same keys, so both read back the same way. Bounded
        // like every other recorded statement — Stripe caps a metadata value at
        // 500 characters and this one arrives from the browser.
        const ageStatement =
          typeof body.age_statement === 'string' &&
          body.age_statement.trim() !== '' &&
          body.age_statement.length <= MAX_CONSENT_STATEMENT_LEN
            ? body.age_statement
            : null

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

        // From the price product, never the subscription's own metadata (which
        // the checkout request body stamped). Null = a live subscription on this
        // email that sells none of our tiers — not something this route may
        // rewrite into one that does.
        const currentTier = await catalogTierOfSubscription(sub, stripe)
        if (!currentTier) {
          return json(409, { error: 'This subscription can’t be changed here.' })
        }

        // A EUR sub updated with USD price_data hard-fails (§6 point 1) — reuse
        // the subscription's own currency, and validate against ITS floor.
        const currency = isSupportedCurrency(sub.currency) ? sub.currency : 'usd'
        const catalog = await resolveCatalogPrice(stripe, newTier, plan)
        const floor = catalog.floors[currency] ?? catalog.floors.usd
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
          if (!windowSpent) {
            introCoupon = pickIntroCoupon(await listActiveCoupons(stripe), currency)
          }
        }

        // Kept for the timing decision below: gaining an entitlement applies
        // immediately, losing one lands at period end.
        const prevEnt = deriveEntitlements(currentTier)
        const nextEnt = deriveEntitlements(newTier)
        const item = sub.items.data[0]
        if (!item) return json(409, { error: 'Subscription has no item to change.' })
        // In the SUBSCRIPTION's currency, like amountCents: `price.unit_amount`
        // is the USD base of a currency_options price, so comparing it here
        // mixed euros with dollars for every non-USD member.
        const prevAmount = item.price ? await subscriptionAmount(stripe, sub, item.price) : null
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
        // An immediate change is charged today and restarts the cycle, which a
        // gift-extended subscription can't take: Stripe refuses the re-anchor
        // on an annual sub whose trial_end sits past it, and on a paused
        // monthly one the restarted paid month would eat into the gifted time.
        // Refused until the gift runs out rather than charging wrongly or
        // spending the gift.
        if (immediate && giftExtensionRunning(sub)) {
          return json(409, {
            error:
              'Your gifted membership time is still running, so this change can’t be made yet. Please contact us and we’ll help.',
          })
        }

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
        // a non-null coupon_id and outcome 'accepted', so a null coupon_id
        // here would leave the discount invisible to the eligibility read
        // and therefore repeatable.
        //
        // Returns the row's id so the response can hand it back: the debundle
        // survey attaches the member's reasons to this same row afterward, the
        // way /cancel-subscription does. Null when nothing was written (a plain
        // upgrade, no DB, or a failed write) — the survey step then no-ops
        // rather than annotating a row that isn't there.
        const recordDebundleWinBack = async (): Promise<string | number | null> => {
          if (!retainedProduct || !env.DATABASE_URL) return null
          try {
            return await insertCancellationSurvey(getDb(env), {
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
            return null
          }
        }

        // The debundle notice. A debundle is a partial cancellation — one
        // product stops, the other continues at a new price. Stripe's receipt
        // for the new amount doesn't arrive until the next invoice, so without
        // this the first signal is a smaller charge.
        //
        // Only for a real debundle: `isDebundle` is what distinguishes dropping
        // a product from a plain upgrade or a PWYC amount change, both of which
        // reach this same route and neither of which is losing anything.
        // Best-effort, and always after the Stripe write has committed.
        const notifyDebundle = async (effectiveIso: string | null) => {
          if (!isDebundle) return
          try {
            const identity = await resolveRequestIdentity(req, env)
            const { subject, html } = renderDebundleEmail({
              firstName: identity?.firstName ?? undefined,
              // retained_product names what was KEPT; the email is about what
              // was removed, which is the other one.
              removed: retainedProduct === 'kept-circle' ? 'ark-plus' : 'circle',
              effectiveOn:
                formatTimestampInZone(effectiveIso, EMAIL_TIME_ZONE, 'long', {
                  withZoneLabel: true,
                }) || null,
              price: formatMinorUnits(amountCents, currency),
              plan,
              accountUrl: `${appBaseUrl}/account/billing`,
            })
            // Keyed on the subscription and the axis dropped, so a retry
            // collapses while a later debundle of the other axis still sends.
            const sent = await sendEmail(env, {
              to: email,
              subject,
              html,
              idempotencyKey: `debundle_${sub.id}_${retainedProduct}`,
            })
            if (!sent) {
              console.error('[email] debundle email did not send:', sub.id)
            }
          } catch (err) {
            console.error('[email] debundle email failed:', err)
          }
        }

        try {
          if (immediate) {
            // Release any prior pending change, then update the item in place
            // (preserves the item id) with exact prorations. The webhook derives
            // the new tier from the price product and syncs Beehiiv/Circle/Neon.
            await releaseScheduleIfAny(stripe, sub, env)
            const priceField = destinationPrice
            // Retention coupons are priced for one product at one cadence, and a
            // subscription-level discount otherwise rides straight through this
            // update: the monthly supporter rate onto an annual invoice, the
            // debundle intro rate onto a re-bundle. Keep every discount except
            // the retention ones that no longer fit where this change lands.
            const survivingDiscounts = await discountsSurvivingChange(stripe, sub, {
              tier: newTier,
              plan,
            })
            // Every immediate change is one the member pays MORE for — gaining an
            // entitlement, monthly→yearly, a PWYC raise (the no-op returned above,
            // and anything cheaper is period-end) — and all of them are charged
            // today and restart the billing cycle from today: the full new price
            // less credit for the unused part of the old one, renewing a full
            // period from now. `always_invoice` bills that immediately, and
            // `error_if_incomplete` makes Stripe REFUSE the update (HTTP 402,
            // nothing changed) when the charge fails, instead of applying it and
            // leaving the member on the dearer plan with an open invoice. Before
            // this, a deferred proration let a member take the Bundle on credit
            // and cancel before ever paying for it, and a declined card still
            // moved a monthly member onto an unpaid annual plan.
            const updated = await stripe.subscriptions.update(sub.id, {
              items: [{ id: item.id, ...priceField }],
              proration_behavior: 'always_invoice',
              payment_behavior: 'error_if_incomplete',
              billing_cycle_anchor: 'now',
              ...(survivingDiscounts !== null ? { discounts: survivingDiscounts } : {}),
              metadata: {
                ...sub.metadata,
                tier: newTier,
                plan,
                amount_cents: String(amountCents),
                currency,
                // Gaining an entitlement is always the immediate branch, so a
                // Fold-granting switch can only land here — the period-end
                // branch is losing one, which asks nothing.
                ...(ageStatement
                  ? {
                      [consentStatementKey(0)]: ageStatement,
                      [CONSENT_ACCEPTED_AT_KEY]: new Date().toISOString(),
                    }
                  : {}),
              },
            })
            if (env.DATABASE_URL) {
              await clearMembershipPending(getDb(env), customerId)
            }
            const surveyId = await recordDebundleWinBack()
            // Immediate: the change is live now, so there is no future date.
            await notifyDebundle(null)
            return json(200, {
              ok: true,
              changed: true,
              timing: 'immediate',
              // The restarted cycle's first renewal.
              next_charge_at: periodEndIso(updated),
              survey_id: surveyId,
            })
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
          // The update REPLACES every phase, so each carries its discounts
          // explicitly. The current phase keeps exactly what it has. The
          // destination keeps the subscription's discounts that still fit where
          // it lands (a checkout promo does; a retention coupon priced for the
          // other product or cadence doesn't — discountsSurvivingChange), plus
          // the debundle intro coupon when one was granted.
          const surviving = await discountsSurvivingChange(stripe, sub, { tier: newTier, plan })
          const carried =
            surviving === null ? existingDiscountParams(sub) : surviving === '' ? [] : surviving
          const destinationDiscounts = [
            ...carried,
            // Phase-scoped so the intro term is measured from the moment the
            // debundled price takes effect. A repeating N-month coupon then
            // discounts every invoice inside that window: N monthly invoices,
            // but only the one annual invoice — so an annual debundler gets a
            // full discounted year. Intended, and what the quote promises.
            ...(introCoupon ? [{ coupon: introCoupon.id }] : []),
          ]
          const currentDiscounts = phaseDiscountParams(currentPhase.discounts)
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
                ...(currentDiscounts.length > 0 ? { discounts: currentDiscounts } : {}),
              },
              {
                items: [{ ...destinationPrice, quantity: 1 }],
                ...(destinationDiscounts.length > 0 ? { discounts: destinationDiscounts } : {}),
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
          const surveyId = await recordDebundleWinBack()
          const effectiveAt = periodEndIso(sub)
          await notifyDebundle(effectiveAt)
          return json(200, {
            ok: true,
            changed: true,
            timing: 'period_end',
            effective_at: effectiveAt,
            survey_id: surveyId,
          })
        } catch (err) {
          // error_if_incomplete (above) turns a failed upgrade charge into a 402
          // with the subscription untouched. That is the member's card, not our
          // outage — say so, and point at the fix, rather than "try again".
          if (isCardPaymentError(err)) {
            console.warn('[stripe] change-tier payment failed:', (err as { code?: string }).code)
            return json(402, {
              error:
                'Your card was declined, so your plan hasn’t changed. Update your card under Manage billing and try again.',
              code: 'payment_failed',
            })
          }
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
        // delivers at least once, so a replay/retry must be inert — but a claim
        // is not a completion. It is taken as 'processing' and only becomes
        // 'done' once dispatch has succeeded; a function that dies in between
        // (a timeout, a crash) never reaches the release in the catch below, and
        // a claim that read as "already processed" would turn Stripe's retry
        // into a no-op and lose the event. So a 'processing' claim is a LEASE:
        // older than WEBHOOK_CLAIM_LEASE_SEC, the next delivery takes it over.
        //
        // One atomic statement, so two concurrent deliveries can't both win: the
        // insert claims a new id; the conflict arm re-claims only a stale
        // 'processing' row; a 'done' row or a live lease returns nothing.
        //
        // A ledger error is non-fatal: fall through and process (dispatch is
        // largely metadata-idempotent on its own).
        let claimedEventId: string | null = null
        let leased = false
        if (env.DATABASE_URL) {
          const sql = getDb(env)
          try {
            let rows: unknown[]
            try {
              rows = (await sql`
                insert into stripe_webhook_events as e (id, type, status, claimed_at)
                values (${event.id}, ${event.type}, 'processing', now())
                on conflict (id) do update
                  set status = 'processing', claimed_at = now()
                  where e.status = 'processing'
                    and (e.claimed_at is null
                         or e.claimed_at < now() - make_interval(secs => ${WEBHOOK_CLAIM_LEASE_SEC}))
                returning id`) as unknown[]
              leased = true
            } catch (err) {
              // Migration 0004 not applied yet (deploy landed before migrate —
              // the ordering that has taken prod down before). Degrade to the
              // single-state claim rather than to no ledger at all.
              if (!isUndefinedColumn(err)) throw err
              if (!warnedLedgerLeaseMissing) {
                warnedLedgerLeaseMissing = true
                console.error(
                  '[stripe] webhook ledger has no status/claimed_at (migration 0004 not applied) — using the single-state claim',
                )
              }
              rows = (await sql`
                insert into stripe_webhook_events (id, type)
                values (${event.id}, ${event.type})
                on conflict (id) do nothing
                returning id`) as unknown[]
            }
            if (rows.length === 0) {
              // Lost the claim. 'done' → a true replay, ack it. Still
              // 'processing' → another delivery holds a live lease; it may yet
              // fail, so this one must NOT be acked — a non-2xx makes Stripe
              // come back, by when the lease is either done or stale.
              if (leased) {
                const held = (await sql`
                  select status from stripe_webhook_events where id = ${event.id}`) as {
                  status: string
                }[]
                if (held[0]?.status === 'processing') {
                  return json(409, { error: 'event_in_progress' })
                }
              }
              return json(200, { received: true, deduped: true })
            }
            claimedEventId = event.id
          } catch (err) {
            console.error('[dev-api] webhook idempotency ledger failed:', err)
          }
        }

        try {
          await dispatchWebhookEvent(event, stripe, env, activator)
          // Dispatch succeeded → the claim becomes a completion. Best-effort: a
          // failure here leaves a 'processing' row that goes stale, and the only
          // cost is that a later redelivery of this event would run again.
          if (claimedEventId && leased) {
            try {
              await getDb(env)`
                update stripe_webhook_events set status = 'done' where id = ${claimedEventId}`
            } catch (doneErr) {
              console.error('[dev-api] webhook claim completion failed:', doneErr)
            }
          }
          json(200, { received: true })
        } catch (err) {
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
