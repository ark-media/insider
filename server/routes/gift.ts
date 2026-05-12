// Gift purchase + activation polling.
//
//   POST /api/gift/create-checkout — one-time PaymentIntent. Activation
//     happens on the webhook (payment_intent.succeeded) via the activator.
//   GET  /api/gift/status         — poll for activation. The giver just
//     created this PI moments ago, so an email param matching PI metadata
//     is sufficient proof of ownership (same pattern as
//     /api/stripe/subscription-status).

import { GIFT_PRICES_CENTS, type GiftTerm } from '../lib/activation.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import type { Deps, Route } from '../lib/route.js'

export function giftRoutes({ stripe, appBaseUrl }: Deps): Route[] {
  // Each create-checkout call provisions a Stripe PaymentIntent and may also
  // create a Stripe customer. Cap per giver email so a scripted caller can't
  // produce thousands of zombie PIs or trigger gift-spam against recipients
  // via the receipt_email Stripe sends on the PI.
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

        const existing = await stripe.customers.list({ email: giverEmail, limit: 1 })
        const customer =
          existing.data[0] ??
          (await stripe.customers.create({
            email: giverEmail,
            name: body.giver_name,
          }))

        const pi = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: 'usd',
          customer: customer.id,
          receipt_email: giverEmail,
          description: `Ark Insider gift · ${term === '6mo' ? '6 months' : '1 year'}`,
          metadata: {
            kind: 'gift',
            term,
            giver_email: giverEmail,
            giver_name: body.giver_name ?? '',
            recipient_email: recipientEmail,
            recipient_name: body.recipient_name ?? '',
            message: body.message ?? '',
          },
        })

        if (!pi.client_secret) {
          return json(500, { error: 'Could not obtain payment client secret' })
        }

        json(200, {
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          amount_cents: amountCents,
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
        const piId = url.searchParams.get('id')
        if (!piId) return json(400, { error: 'id required' })

        const emailParam = url.searchParams.get('email')?.trim().toLowerCase()
        const pi = await stripe.paymentIntents.retrieve(piId)
        const giver = pi.metadata?.giver_email?.toLowerCase()
        if (!emailParam || !giver || emailParam !== giver) {
          return json(403, { error: 'Forbidden' })
        }

        json(200, {
          status: pi.status,
          activated: Boolean(pi.metadata?.sc_subscription_id),
        })
      },
    },
  ]
}
