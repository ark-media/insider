// Stripe checkout + webhook routes.
//
//   POST /api/stripe/create-checkout-session — create a subscription-mode
//     Checkout Session (ui_mode: 'elements') with Adaptive Pricing enabled,
//     so the SPA can render Stripe's Payment + Currency Selector Elements and
//     charge the buyer in their detected local currency. We use the Checkout
//     Sessions API (not a bare Subscription) specifically because Adaptive
//     Pricing is only available through Checkout Sessions.
//   POST /api/stripe/cancel-subscription   — cancel at period end.
//   GET  /api/stripe/subscription-status   — poll for activation after
//     PaymentIntent confirm (the client races the webhook).
//   POST /api/stripe/webhook               — server-to-server signal from
//     Stripe; the source of truth for SC + entitlement state.

import type Stripe from 'stripe'
import { AlreadySubscribedError } from '../lib/activation.js'
import { emailForStripeCustomer, syncEntitlement } from '../entitlement.js'
import { downgradeToFree, tryPush } from '../lib/beehiiv-sync.js'
import { getDb } from '../lib/db.js'
import { createScClient } from '../lib/sc-client.js'
import { listActiveCoupons, pickBestCoupon } from '../lib/stripe-promos.js'
import { getPlanPriceCents } from '../lib/pricing.js'
import { makeJsonRes, readBody, readJson } from '../lib/http.js'
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
        const defaultCents = await getPlanPriceCents(stripe, env, plan)

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
          ...(discountCoupon ? { discounts: [{ coupon: discountCoupon }] } : {}),
          // Stamp the subscription so the existing webhook
          // (customer.subscription.created) activates SC + entitlement
          // unchanged — the session is just the funnel that creates it.
          subscription_data: {
            metadata: {
              plan,
              custom_amount_cents: String(amountCents),
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
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const cancelEmail = await getSessionEmail(req, env)
        if (!cancelEmail) return json(401, { error: 'unauthenticated' })

        // Checkout creates a Customer per session, so one email can map to
        // several Stripe customers (e.g. churn-then-resubscribe). Search across
        // all of them for the active subscription rather than assuming one.
        const customers = await stripe.customers.list({ email: cancelEmail, limit: 100 })
        if (customers.data.length === 0) {
          return json(404, { error: 'No billing record found' })
        }

        let sub: Stripe.Subscription | undefined
        for (const customer of customers.data) {
          const subs = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'active',
            limit: 1,
          })
          if (subs.data[0]) {
            sub = subs.data[0]
            break
          }
        }
        if (!sub) return json(404, { error: 'No active subscription found' })

        // Cancel at period end so they keep access until the billing cycle ends.
        await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true })

        const periodEnd = new Date(sub.items.data[0].current_period_end * 1000).toISOString()
        json(200, { ok: true, access_until: periodEnd })
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

        // Verify the caller owns this subscription. New subscribers may not
        // have an Auth0 session yet (they just paid), so we accept an `email`
        // query param as a fallback — the email was just used to create the
        // subscription moments ago.
        const emailParam = url.searchParams.get('email')?.trim().toLowerCase()
        const auth0Email = await getSessionEmail(req, env)
        const sub = await stripe.subscriptions.retrieve(subId, {
          expand: ['customer'],
        })
        const customer = sub.customer
        const customerEmail =
          typeof customer === 'object' && customer && !('deleted' in customer && customer.deleted)
            ? (customer as Stripe.Customer).email?.toLowerCase() ?? null
            : null
        const callerEmail = auth0Email ?? emailParam
        if (!callerEmail || callerEmail !== customerEmail) {
          return json(403, { error: 'Forbidden' })
        }

        json(200, {
          status: sub.status,
          activated: Boolean(sub.metadata?.sc_subscription_id),
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
          return json(400, {
            error: `Webhook signature verification failed: ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          })
        }

        try {
          await dispatchWebhookEvent(event, stripe, env, activator)
          json(200, { received: true })
        } catch (err) {
          if (err instanceof AlreadySubscribedError) {
            // The buyer already has an active SC sub — retrying the webhook
            // won't fix that, so ack 200 and rely on the auth route's 409 to
            // surface the situation to the buyer. Manual billing follow-up.
            console.warn('[dev-api] webhook: already subscribed:', err.email)
            return json(200, { received: true, skipped: 'already_subscribed' })
          }
          console.error('[dev-api] webhook handler error:', err)
          if (err && typeof err === 'object' && 'data' in err) {
            console.error('[dev-api] webhook error data:', JSON.stringify((err as { data: unknown }).data, null, 2))
          }
          json(500, {
            error: err instanceof Error ? err.message : 'Webhook handler error',
          })
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
        await syncEntitlement(env, email, isActive ? 'subscriber' : 'free')
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
