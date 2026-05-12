// Stripe checkout + webhook routes.
//
//   POST /api/stripe/create-subscription   — create a Subscription with
//     payment_behavior: 'default_incomplete' so the SPA can confirm the
//     PaymentIntent client-side.
//   POST /api/stripe/cancel-subscription   — cancel at period end.
//   GET  /api/stripe/subscription-status   — poll for activation after
//     PaymentIntent confirm (the client races the webhook).
//   POST /api/stripe/webhook               — server-to-server signal from
//     Stripe; the source of truth for SC + entitlement state.

import type Stripe from 'stripe'
import { emailForStripeCustomer, syncEntitlement } from '../entitlement.js'
import { createScClient } from '../lib/sc-client.js'
import { makeJsonRes, readBody, readJson } from '../lib/http.js'
import { getSessionEmail } from '../lib/session.js'
import type { Deps, Env, Route } from '../lib/route.js'

export function stripeRoutes({ env, stripe, appBaseUrl, activator }: Deps): Route[] {
  // Stripe price cache — keyed by `${plan}-${amountCents}` to avoid creating
  // a fresh Price object on every pay-what-you-want checkout.
  const priceCache = new Map<string, string>()

  return [
    {
      path: '/api/stripe/create-subscription',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const body =
          (await readJson<{
            email?: string
            plan?: 'monthly' | 'yearly'
            custom_amount_cents?: number
            name?: string
          }>(req)) ?? {}

        if (!body.email) return json(400, { error: 'Email is required' })
        if (body.plan !== 'monthly' && body.plan !== 'yearly') {
          return json(400, { error: 'plan must be "monthly" or "yearly"' })
        }
        const plan = body.plan
        const interval: 'month' | 'year' = plan === 'monthly' ? 'month' : 'year'
        const defaultCents = plan === 'monthly' ? 800 : 8000

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

        // Find-or-create Stripe customer by email.
        const existing = await stripe.customers.list({ email: body.email, limit: 1 })
        const customer =
          existing.data[0] ??
          (await stripe.customers.create({ email: body.email, name: body.name }))

        // Resolve price. Prefer the configured fixed price, else reuse a
        // cached dynamic one, else create + cache a new one.
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

        const subscription = await stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: priceId }],
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          expand: ['latest_invoice.confirmation_secret'],
          metadata: {
            plan,
            custom_amount_cents: String(amountCents),
          },
        })

        const invoice = subscription.latest_invoice as Stripe.Invoice | null
        const clientSecret = invoice?.confirmation_secret?.client_secret
        if (!clientSecret) {
          return json(500, { error: 'Could not obtain payment client secret' })
        }

        json(200, {
          subscription_id: subscription.id,
          client_secret: clientSecret,
          amount_cents: amountCents,
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

        const customers = await stripe.customers.list({ email: cancelEmail, limit: 1 })
        const customer = customers.data[0]
        if (!customer) return json(404, { error: 'No billing record found' })

        const subs = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'active',
          limit: 1,
        })
        const sub = subs.data[0]
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
      // Skip the entitlement sync on metadata-only updates. Stripe fires
      // customer.subscription.updated for everything (payment method swaps,
      // metadata edits, etc.); only a status change can flip the user's tier.
      // `created` always counts as a status change.
      const prev = (event.data.previous_attributes ?? {}) as Partial<Stripe.Subscription>
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
      if (email) await syncEntitlement(env, email, 'free')
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
