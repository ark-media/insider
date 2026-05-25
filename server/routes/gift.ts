// Gift purchase + activation polling.
//
//   POST /api/gift/create-checkout — one-time, payment-mode Checkout Session
//     (ui_mode: 'elements') with Adaptive Pricing, so the buyer is charged in
//     their detected local currency. We use a Checkout Session (not a bare
//     PaymentIntent) specifically because Adaptive Pricing is only available
//     through Checkout Sessions. Gift metadata is stamped on the underlying
//     PaymentIntent (payment_intent_data) so activation happens on the webhook
//     (payment_intent.succeeded) via the activator, unchanged.
//   GET  /api/gift/status         — poll for activation. The giver just
//     created this Session moments ago, so an email param matching the
//     Session's giver_email metadata is sufficient proof of ownership (same
//     pattern as /api/stripe/subscription-status).

import { GIFT_PRICES_CENTS, type GiftTerm } from '../lib/activation.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import type { Deps, Route } from '../lib/route.js'

export function giftRoutes({ stripe, appBaseUrl }: Deps): Route[] {
  // Each create-checkout call provisions a Stripe Checkout Session (and its
  // PaymentIntent) and may also create a Stripe customer. Cap per giver email
  // so a scripted caller can't produce thousands of zombie sessions or trigger
  // gift-spam against recipients via the receipt_email Stripe sends.
  const giftLimiter = createRateLimiter({
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })

  return [
    {
      path: '/api/gift/create-checkout',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const body =
          (await readJson<{
            giver_email?: string
            giver_name?: string
            recipient_email?: string
            recipient_name?: string
            term?: GiftTerm
            message?: string
          }>(req)) ?? {}

        const giverEmail = body.giver_email?.trim().toLowerCase()
        const recipientEmail = body.recipient_email?.trim().toLowerCase()
        if (!giverEmail) return json(400, { error: 'Your email is required.' })
        if (!recipientEmail) return json(400, { error: "Recipient's email is required." })
        if (body.term !== '6mo' && body.term !== '1yr') {
          return json(400, { error: 'term must be "6mo" or "1yr"' })
        }
        if (body.message && body.message.length > 500) {
          return json(400, { error: 'Message is too long (max 500 characters).' })
        }

        const wait = giftLimiter.take(giverEmail)
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, {
            error: 'Too many gift attempts. Please wait a moment and try again.',
          })
        }

        const term = body.term
        const amountCents = GIFT_PRICES_CENTS[term]
        const termLabel = term === '6mo' ? '6 months' : '1 year'

        const existing = await stripe.customers.list({ email: giverEmail, limit: 1 })
        const customer =
          existing.data[0] ??
          (await stripe.customers.create({
            email: giverEmail,
            name: body.giver_name,
          }))

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          ui_mode: 'elements',
          // Setting `customer` supplies the giver's email to the Session, so the
          // SPA confirms in place without a client-side email step (the giver's
          // email is already known when the modal opens).
          customer: customer.id,
          line_items: [
            {
              quantity: 1,
              // Always USD — the source currency Adaptive Pricing converts from
              // per buyer. The gift price is fixed, so an inline price_data
              // avoids minting reusable Price objects.
              price_data: {
                currency: 'usd',
                unit_amount: amountCents,
                product_data: { name: `Ark Insider gift · ${termLabel}` },
              },
            },
          ],
          // Adaptive Pricing: Stripe detects the buyer's country from their IP
          // and presents/charges in their local currency, with the USD price
          // above as the source. Requires the account-level setting in the
          // Stripe Dashboard (Settings → Adaptive Pricing) — this flag is inert
          // until that is enabled.
          adaptive_pricing: { enabled: true },
          // Stamp the PaymentIntent so the existing webhook
          // (payment_intent.succeeded, kind:'gift') activates SC + entitlement
          // unchanged — the Session is just the funnel that creates it.
          payment_intent_data: {
            receipt_email: giverEmail,
            description: `Ark Insider gift · ${termLabel}`,
            metadata: {
              kind: 'gift',
              term,
              giver_email: giverEmail,
              giver_name: body.giver_name ?? '',
              recipient_email: recipientEmail,
              recipient_name: body.recipient_name ?? '',
              message: body.message ?? '',
            },
          },
          // Lightweight Session-level metadata for the ownership check in
          // /api/gift/status (avoids expanding the PaymentIntent just to authz).
          metadata: { kind: 'gift', giver_email: giverEmail },
          // Required for ui_mode 'elements'; only used when a payment method
          // needs an off-site redirect (e.g. 3DS). The modal otherwise confirms
          // in place and polls /api/gift/status.
          return_url: `${appBaseUrl}/?gift=complete&session_id={CHECKOUT_SESSION_ID}`,
        })

        if (!session.client_secret) {
          return json(500, { error: 'Could not obtain checkout client secret' })
        }

        json(200, {
          checkout_session_id: session.id,
          client_secret: session.client_secret,
          term,
        })
      },
    },

    {
      path: '/api/gift/status',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
        const url = new URL(req.url ?? '/', appBaseUrl)
        const sessionId = url.searchParams.get('id')
        if (!sessionId) return json(400, { error: 'id required' })

        const emailParam = url.searchParams.get('email')?.trim().toLowerCase()
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['payment_intent'],
        })
        const giver = session.metadata?.giver_email?.toLowerCase()
        if (!emailParam || !giver || emailParam !== giver) {
          return json(403, { error: 'Forbidden' })
        }

        // The PaymentIntent carries the live status and the sc_subscription_id
        // the webhook stamps on activation.
        const pi =
          typeof session.payment_intent === 'object' ? session.payment_intent : null
        json(200, {
          status: pi?.status ?? session.status ?? 'unknown',
          activated: Boolean(pi?.metadata?.sc_subscription_id),
        })
      },
    },
  ]
}
