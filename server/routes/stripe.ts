// Stripe checkout + webhook routes.
//
//   POST /api/stripe/create-checkout-session — create a subscription-mode
//     Checkout Session (ui_mode: 'elements') with Adaptive Pricing enabled,
//     so the SPA can render Stripe's Payment + Currency Selector Elements and
//     charge the buyer in their detected local currency. We use the Checkout
//     Sessions API (not a bare Subscription) specifically because Adaptive
//     Pricing is only available through Checkout Sessions.
//   POST /api/stripe/cancel-subscription   — cancel at period end.
//   POST /api/stripe/reactivate-subscription — undo a pending cancel.
//   GET  /api/stripe/subscription-status   — poll for activation after
//     PaymentIntent confirm (the client races the webhook).
//   GET  /api/stripe/my-subscription       — the signed-in member's cancel
//     schedule, so the account page can persist a "set to cancel" state.
//   POST /api/stripe/webhook               — server-to-server signal from
//     Stripe; the source of truth for SC + entitlement state.

import type Stripe from 'stripe'
import { AlreadySubscribedError } from '../lib/activation.js'
import { emailForStripeCustomer, redactEmail, syncEntitlement } from '../entitlement.js'
import { downgradeToFree, tryPush } from '../lib/beehiiv-sync.js'
import { getDb } from '../lib/db.js'
import { hasAcceptedRetention, insertCancellationSurvey } from '../lib/cancellation.js'
import { pickRetentionCoupon, toRetentionOffer } from '../lib/retention.js'
import {
  isCancelOfferOutcome,
  isCancellationReason,
  MAX_CANCELLATION_NOTE_LEN,
} from '../../shared/cancellation.js'
import { createScClient } from '../lib/sc-client.js'
import { listActiveCoupons, pickBestCoupon } from '../lib/stripe-promos.js'
import { FOUNDING_MULTIPLE, getPlanPriceCents, type Plan } from '../lib/pricing.js'
import { isSameOrigin, makeJsonRes, readBody, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { getSessionEmail } from '../lib/session.js'
import type { Deps, Env, Route } from '../lib/route.js'

// Loose RFC-shaped check — sufficient to reject obvious junk before it
// reaches stripe.customers.list/create. Stripe will validate canonical form
// downstream; this just keeps us from minting Customer rows for "   foo".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Stripe's hard limit is 256; we cap a touch lower to leave room.
const MAX_NAME_LEN = 250

// Find a Customer for this email or create one. Checkout has historically
// created a Customer per Session, so one email can map to several customers
// (churn-then-resubscribe). Prefer one without an active subscription so a
// new sub doesn't end up on a customer that already has one — bounded scan
// keeps the API cost modest even with many matches.
async function findOrCreateSubscriber(
  stripe: Stripe,
  opts: { email: string; name?: string },
): Promise<Stripe.Customer> {
  const { email, name } = opts
  const list = await stripe.customers.list({ email, limit: 100 })
  if (list.data.length === 0) {
    return stripe.customers.create({ email, name })
  }
  if (list.data.length === 1) return list.data[0]
  // Multiple matches — try to pick a clean one. Cap the scan so a pathological
  // case (many duplicates) doesn't fan out to dozens of Stripe calls.
  for (const c of list.data.slice(0, 10)) {
    const subs = await stripe.subscriptions.list({
      customer: c.id,
      status: 'active',
      limit: 1,
    })
    if (subs.data.length === 0) return c
  }
  return list.data[0]
}

// Find the active subscription for an email across all its Stripe customers.
// Checkout creates a Customer per session, so one email can map to several
// (churn-then-resubscribe); scan them all rather than assuming one. The
// per-customer lookups run concurrently (one email rarely has many customers,
// but this keeps the cancel flow off a serial chain of round-trips). Null when
// the email has no billing record or no active subscription.
//
// `status: 'active'` is deliberate: both the cancel and the retention offer
// target a healthy live subscription. A delinquent (past_due/unpaid) or
// trialing sub is intentionally not matched here — it's handled by Stripe's
// own dunning/trial lifecycle, not this flow.
async function findActiveSubscription(
  stripe: Stripe,
  email: string,
): Promise<Stripe.Subscription | null> {
  const customers = await stripe.customers.list({ email, limit: 100 })
  const subLists = await Promise.all(
    customers.data.map((customer) =>
      stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 }),
    ),
  )
  for (const subs of subLists) {
    if (subs.data[0]) return subs.data[0]
  }
  return null
}

// The plan a subscription bills on, from its recurring interval, so the cancel
// save flow can offer a plan-targeted retention coupon. Null when the interval
// isn't month/year (or the sub has no items) — the picker then offers only
// untargeted coupons rather than guessing.
function planFromSubscription(sub: Stripe.Subscription): Plan | null {
  const interval = sub.items.data[0]?.price?.recurring?.interval
  if (interval === 'month') return 'monthly'
  if (interval === 'year') return 'yearly'
  return null
}

// The subscription's current-period-end as an ISO string, or null when the sub
// has no items / no finite timestamp. Used for the renewal/access date in the
// cancel, reactivate, and accept-offer responses — all read it *after* a Stripe
// write has already succeeded, so an itemless sub must degrade to null rather
// than throw a 500 that strands an action that already happened.
function periodEndIso(sub: Stripe.Subscription): string | null {
  const ts = sub.items.data[0]?.current_period_end
  return ts != null && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null
}

export function stripeRoutes({ env, stripe, appBaseUrl, activator }: Deps): Route[] {
  // Stripe price cache — keyed by `${plan}-${amountCents}` to avoid creating
  // a fresh Price object on every pay-what-you-want checkout.
  const priceCache = new Map<string, string>()

  // Per-email cap on Checkout Session creation. Mirrors the gift flow: a
  // scripted caller can't produce thousands of zombie Sessions / Customer
  // rows. Small enough to catch abuse and large enough that a real buyer
  // retrying a few times doesn't get blocked.
  const subscribeLimiter = createRateLimiter({
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })

  return [
    {
      path: '/api/stripe/create-checkout-session',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const body =
          (await readJson<{
            email?: string
            name?: string
            plan?: 'monthly' | 'yearly'
            custom_amount_cents?: number
          }>(req)) ?? {}

        // Email is required up front so we can pre-create the Stripe Customer
        // with it (mirroring the gift flow). Without this, subscription-mode
        // Checkout creates the Customer from whatever Elements collects later,
        // which leaves a window — and any Dashboard-created test sub — where
        // customer.email is null and the webhook's activation 500s forever.
        const email = body.email?.trim().toLowerCase()
        if (!email) return json(400, { error: 'Email is required.' })
        if (!EMAIL_RE.test(email)) {
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
        // Checkout still sells only Ark+ here; task 8 makes it per-tier.
        const defaultCents = await getPlanPriceCents(stripe, 'ark-plus', plan)

        // The "name your price" amount is entered in USD — the source currency
        // Adaptive Pricing converts from. The buyer sees and pays the localized
        // equivalent at checkout.
        let amountCents = defaultCents
        if (
          typeof body.custom_amount_cents === 'number' &&
          Number.isFinite(body.custom_amount_cents)
        ) {
          if (body.custom_amount_cents < defaultCents) {
            return json(400, {
              error: `Custom amount must be at least $${defaultCents / 100}.`,
            })
          }
          if (body.custom_amount_cents > 1_000_000) {
            return json(400, { error: 'Custom amount too large.' })
          }
          amountCents = Math.round(body.custom_amount_cents)
        }

        // Resolve price. Prefer the configured fixed price, else reuse a
        // cached dynamic one, else create + cache a new one. Always USD — the
        // source currency Adaptive Pricing converts from per buyer.
        const fixedPriceId =
          plan === 'monthly' ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_YEARLY
        let priceId: string
        if (amountCents === defaultCents && fixedPriceId) {
          priceId = fixedPriceId
        } else {
          const cacheKey = `${plan}-${amountCents}`
          const cached = priceCache.get(cacheKey)
          if (cached) {
            priceId = cached
          } else {
            const price = await stripe.prices.create({
              currency: 'usd',
              unit_amount: amountCents,
              recurring: { interval },
              // Exclusive: the USD amount above is pre-tax and Stripe Tax adds
              // tax on top at checkout. Required once automatic_tax is on — a
              // price with no tax_behavior errors under automatic tax. The fixed
              // STRIPE_PRICE_* prices carry this via their Dashboard config.
              tax_behavior: 'exclusive',
              product_data: {
                name: `Ark Insider — ${plan === 'monthly' ? 'Monthly' : 'Yearly'}`,
              },
            })
            priceId = price.id
            priceCache.set(cacheKey, priceId)
          }
        }

        // Auto-apply the best active promo for this plan. Discovered fresh from
        // Stripe (the source of truth) — the client never influences the
        // discount. Ranked against the USD source amount; Adaptive Pricing then
        // converts the discounted total. The discount is optional, so a lookup
        // failure must never block checkout: log and charge full price.
        let discountCoupon: string | null = null
        try {
          const best = pickBestCoupon(await listActiveCoupons(stripe), plan, amountCents)
          if (best) discountCoupon = best.id
        } catch (err) {
          console.error('[stripe] promo lookup failed; charging full price:', err)
        }

        // Find-or-reuse a customer so we never mint duplicates for the same
        // email (and so the resulting subscription's customer always has an
        // email — see the comment above). Checkout has historically created
        // a Customer per Session, so one email can map to several customers
        // (churn-then-resubscribe). Prefer one without an active subscription
        // so the new sub doesn't end up doubled up on a customer that
        // already has one.
        const customer = await findOrCreateSubscriber(stripe, {
          email,
          name: body.name,
        })

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          ui_mode: 'elements',
          customer: customer.id,
          line_items: [{ price: priceId, quantity: 1 }],
          // Adaptive Pricing: Stripe detects the buyer's country from their IP
          // and presents/charges in their local currency, with the USD price
          // above as the source. Requires the account-level setting in the
          // Stripe Dashboard (Settings → Adaptive Pricing) — this flag is inert
          // until that is enabled.
          adaptive_pricing: { enabled: true },
          // Stripe Tax: compute and add tax on top of the (exclusive) price.
          // For Checkout Sessions this also enables automatic_tax on the
          // subscription Checkout creates — no separate subscriptions.create.
          // Requires Stripe Tax to be active with registrations in the
          // Dashboard, or session creation errors.
          automatic_tax: { enabled: true },
          // Persist the billing address the buyer enters (BillingAddressElement)
          // back onto the pre-set Customer. Without this, Checkout rejects a new
          // address for an attached customer — and Stripe Tax needs the address
          // to determine the jurisdiction.
          customer_update: { address: 'auto' },
          ...(discountCoupon ? { discounts: [{ coupon: discountCoupon }] } : {}),
          // Stamp the subscription so the existing webhook
          // (customer.subscription.created) activates SC + entitlement
          // unchanged — the session is just the funnel that creates it.
          subscription_data: {
            metadata: {
              plan,
              custom_amount_cents: String(amountCents),
              // Founding Member: anyone giving at least twice the base price.
              // Derived here from the amount we're actually charging — the
              // client sends no such flag, so the tier can't be claimed, only
              // paid for. Recorded now so the badge can be provisioned in
              // Circle later without re-deriving it from historical amounts.
              founding_member: String(amountCents >= defaultCents * FOUNDING_MULTIPLE),
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
        })
      },
    },

    {
      path: '/api/stripe/cancel-subscription',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

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

        const sub = await findActiveSubscription(stripe, cancelEmail)
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

        // Cancel at period end so they keep access until the billing cycle ends.
        await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true })

        json(200, { ok: true, access_until: periodEndIso(sub) })
      },
    },

    {
      // Undo a pending cancel: clear cancel_at_period_end so the subscription
      // renews normally again. Only reachable while the cancel is still
      // scheduled (the sub stays `active` until the period ends); once it has
      // lapsed the member is no longer Ark+ and re-subscribes via checkout
      // instead. Unlike accept-retention-offer this attaches no coupon and
      // burns no eligibility — it's a plain resume. The webhook's
      // syncScCancelSchedule mirrors the cleared schedule back to SC.
      path: '/api/stripe/reactivate-subscription',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findActiveSubscription(stripe, email)
        if (!sub) return json(404, { error: 'No active subscription found' })

        // Idempotent: if it isn't actually scheduled to cancel there's nothing
        // to undo — report success with the existing renewal date.
        const updated = sub.cancel_at_period_end
          ? await stripe.subscriptions.update(sub.id, {
              cancel_at_period_end: false,
            })
          : sub

        json(200, { ok: true, next_charge_at: periodEndIso(updated) })
      },
    },

    {
      // Is this member eligible for a retention discount, and what is it? Read
      // on open of the cancel flow: eligible iff they have an active sub AND a
      // valid retention coupon is configured AND they've never accepted before.
      // Every ineligible branch returns the same {eligible:false, offer:null}
      // so the client can't tell *why* — the member never learns an offer
      // existed. Failures fail closed (no offer), never 500 the flow.
      path: '/api/stripe/retention-offer',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const ineligible = { eligible: false, offer: null }

        const sub = await findActiveSubscription(stripe, email)
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
    },

    {
      // Accept the retention offer: attach the coupon to the live subscription
      // and clear any pending cancel in one update, so a member who had already
      // scheduled a cancellation is fully reinstated. The coupon is re-derived
      // server-side (never trusted from the client) and an accepted survey row
      // is written, which burns eligibility.
      path: '/api/stripe/accept-retention-offer',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findActiveSubscription(stripe, email)
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
    },

    {
      path: '/api/stripe/subscription-status',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
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
          activated: Boolean(sub.metadata?.sc_subscription_id),
        })
      },
    },

    {
      // The signed-in member's cancel schedule, for the account page to show a
      // persistent "scheduled to cancel" state across reloads — the in-page
      // confirmation after cancelling is transient client state and is lost on
      // refresh. Keyed by the session email (never a self-asserted one). A
      // scheduled cancel keeps the subscription `status: 'active'` until the
      // period actually ends, so findActiveSubscription still matches it. Fails
      // closed to "no pending cancel" so a Stripe hiccup degrades to showing the
      // cancel button rather than an error.
      path: '/api/stripe/my-subscription',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        const sub = await findActiveSubscription(stripe, email)
        // When cancel_at_period_end is set, Stripe populates cancel_at; fall back
        // to the current period end so we always have a date to show.
        let cancelAt: string | null = null
        if (sub?.cancel_at_period_end) {
          cancelAt =
            sub.cancel_at != null && Number.isFinite(sub.cancel_at)
              ? new Date(sub.cancel_at * 1000).toISOString()
              : periodEndIso(sub)
        }
        json(200, {
          cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
          cancelAt,
        })
      },
    },

    {
      // Reads the raw body via readBody() before any JSON parsing. Stripe's
      // signature is over the exact bytes Stripe sent, so any upstream body
      // parser would invalidate constructEvent().
      path: '/api/stripe/webhook',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
        const whSecret = env.STRIPE_WEBHOOK_SECRET
        if (!whSecret) return json(500, { error: 'STRIPE_WEBHOOK_SECRET missing' })

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
    },
  ]
}

async function dispatchWebhookEvent(
  event: Stripe.Event,
  stripe: Stripe,
  env: Env,
  activator: Deps['activator'],
): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const isActive = sub.status === 'active' || sub.status === 'trialing'
      if (isActive) {
        await activator.activateScSubscriptionForStripeSub(sub)
      }
      const prev = (event.data.previous_attributes ?? {}) as Partial<Stripe.Subscription>

      // Mirror Stripe's scheduled-cancel state onto the SC subscription so feed
      // access self-expires on time even if the later
      // customer.subscription.deleted webhook is missed. The entitlement
      // reconciler heals Auth0/Circle drift but never touches SC, so without
      // this SC is the one single point of failure for the paid product.
      // Bidirectional: un-canceling (cancel_at cleared) restores autorenew.
      await syncScCancelSchedule(sub, prev, env)

      // Skip the entitlement sync on metadata-only updates. Stripe fires
      // customer.subscription.updated for everything (payment method swaps,
      // metadata edits, etc.); only a status change can flip the user's tier.
      // `created` always counts as a status change.
      const statusChanged =
        event.type === 'customer.subscription.created' || 'status' in prev
      if (!statusChanged) break
      // Entitlement sync runs after SC so a Circle/Auth0 outage can never
      // block podcast feed access (the paid product).
      const email = await emailForStripeCustomer(sub.customer, stripe)
      if (email) {
        await syncEntitlement(env, email, isActive ? 'ark-plus' : 'free')
      }
      break
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused': {
      const sub = event.data.object as Stripe.Subscription
      const scSubId = sub.metadata?.sc_subscription_id
      if (scSubId) {
        const sc = createScClient(env)
        try {
          await sc.call('DELETE', `/subscriptions/${scSubId}`)
        } catch (err) {
          console.error('[dev-api] SC cancel failed:', err)
        }
      }
      const email = await emailForStripeCustomer(sub.customer, stripe)
      if (email) {
        await syncEntitlement(env, email, 'free')
        // Drop the premium tier in Beehiiv but keep them on the free list.
        // They can opt out of the free dispatch themselves from
        // /account/newsletters.
        if (env.DATABASE_URL) {
          await tryPush('downgrade (cancel)', () =>
            downgradeToFree({ env, sql: getDb(env) }, email),
          )
        }
      }
      break
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      if (pi.metadata?.kind === 'gift') {
        await activator.activateScGiftForPaymentIntent(pi)
      }
      break
    }
    case 'invoice.payment_failed': {
      console.warn(
        '[stripe] invoice.payment_failed',
        (event.data.object as Stripe.Invoice).id,
      )
      break
    }
    default:
      break
  }
}

// Push Stripe's scheduled-cancel state onto the SC subscription. Only acts when
// the cancel schedule actually changed in this event (cancel_at /
// cancel_at_period_end present in previous_attributes), so routine updates —
// payment-method swaps, our own metadata stamp from activation — don't generate
// spurious SC writes.
//
//   scheduled to cancel → ends_at = cancel_at, autorenew = false  (SC shows
//     "Expiring"; the member keeps access until ends_at, then SC expires them)
//   un-canceled         → ends_at = null,       autorenew = true
//
// `status` is left for SC to derive. Soft-fail like the DELETE path: a transient
// SC error must not 500 the webhook (which would make Stripe retry the event).
async function syncScCancelSchedule(
  sub: Stripe.Subscription,
  prev: Partial<Stripe.Subscription>,
  env: Env,
): Promise<void> {
  // Named for what we actually check — fields present in `previous_attributes`
  // — not "the schedule semantically changed," which Stripe doesn't tell us.
  const cancelFieldsPresent =
    'cancel_at' in prev || 'cancel_at_period_end' in prev
  if (!cancelFieldsPresent) return
  const scSubId = sub.metadata?.sc_subscription_id
  if (!scSubId) return
  // Guard against a malformed payload pushing "Invalid Date" to SC, where it
  // would silently 422 into the catch and produce an unhelpful log line.
  const hasValidCancelAt =
    sub.cancel_at != null && Number.isFinite(sub.cancel_at)
  const body = hasValidCancelAt
    ? { ends_at: new Date(sub.cancel_at! * 1000).toISOString(), autorenew: false }
    : { ends_at: null, autorenew: true }
  try {
    await createScClient(env).call('PATCH', `/subscriptions/${scSubId}`, body)
  } catch (err) {
    console.error('[dev-api] SC cancel-schedule sync failed:', err)
  }
}
