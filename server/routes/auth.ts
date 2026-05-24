// Auth/session routes.
//
//   POST /api/auth/checkout-session — brand-new subscribers don't have an
//     Auth0 password yet; the webhook will send them a password-reset email
//     so they can pick one for future logins. To get them into /setup
//     immediately without round-tripping through that email, we provision
//     their account synchronously and hand back a short-lived HS256 JWT
//     usable as a Bearer token. The other routes accept either Auth0 RS256
//     tokens or this token (see lib/session.ts).
//   POST /api/signout — clears the checkout-session cookies. The client
//     calls this before Auth0 logout so brand-new subscribers fully sign
//     out without leaving a 30-min cookie behind.

import type Stripe from 'stripe'
import {
  CHECKOUT_TOKEN_TTL_SEC,
  clearCheckoutCookies,
  setCheckoutCookies,
} from '../lib/cookies.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { signCheckoutToken } from '../lib/session.js'
import type { Deps, Route } from '../lib/route.js'

// Defense against replay of leaked (checkout_session_id, email) pairs:
// auto-login is only valid during the brief window right after checkout. After
// that, the user logs in normally via Auth0 with the password they set from the
// reset email.
const AUTO_LOGIN_WINDOW_SEC = 60 * 60

export function authRoutes({ env, stripe, activator }: Deps): Route[] {
  // /api/auth/checkout-session is polled by the client (~1 req/s during the
  // 20s window after payment). Cap per Checkout Session to defend the upstream
  // Stripe + Auth0 APIs from runaway loops or scripted abuse.
  const checkoutSessionLimiter = createRateLimiter({
    capacity: 25,
    refillPerSec: 1,
  })

  return [
    {
      path: '/api/auth/checkout-session',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
        if (!env.CHECKOUT_SESSION_SECRET) {
          return json(500, { error: 'CHECKOUT_SESSION_SECRET missing' })
        }

        const body =
          (await readJson<{ checkout_session_id?: string; email?: string }>(req)) ?? {}
        const sessionId = body.checkout_session_id?.trim()
        const emailParam = body.email?.trim().toLowerCase()
        if (!sessionId) return json(400, { error: 'checkout_session_id required' })
        if (!emailParam) return json(400, { error: 'email required' })

        const wait = checkoutSessionLimiter.take(sessionId)
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'Too many attempts. Please wait a moment.' })
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['subscription', 'subscription.customer'],
        })

        // The Checkout Session creates the subscription only once payment
        // completes. Until then there's nothing to provision — tell the client
        // to retry.
        const sub =
          typeof session.subscription === 'object' && session.subscription
            ? session.subscription
            : null
        if (!sub) {
          return json(202, { ready: false, status: session.status ?? 'open' })
        }

        const customer = sub.customer
        const customerEmail =
          typeof customer === 'object' &&
          customer &&
          !('deleted' in customer && customer.deleted)
            ? (customer as Stripe.Customer).email?.toLowerCase() ?? null
            : null
        if (!customerEmail || customerEmail !== emailParam) {
          return json(403, { error: 'Forbidden' })
        }

        if (Date.now() / 1000 - sub.created > AUTO_LOGIN_WINDOW_SEC) {
          return json(410, {
            error: 'Auto-login window expired. Please sign in via the link in your welcome email.',
          })
        }

        // Stripe activates the subscription only after the payment confirms.
        // The client calls this endpoint right after checkout.confirm()
        // resolves, but Stripe's internal state transition can lag by a few
        // hundred ms. Tell the client to retry.
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          return json(202, { ready: false, status: sub.status })
        }

        // Provision SC user + SC subscription + Auth0 user. Idempotent — if
        // the webhook already ran, this is a no-op. Failures here mean the
        // caller paid but provisioning is incomplete; the webhook will retry
        // async, but we shouldn't hand out a session token yet.
        try {
          await activator.activateScSubscriptionForStripeSub(sub)
        } catch (err) {
          console.error('[auth/checkout-session] provision failed:', err)
          return json(502, {
            error: 'Could not finish setting up your account. Please try again.',
          })
        }

        const accessToken = await signCheckoutToken(customerEmail, env)
        setCheckoutCookies(res, accessToken, env)
        json(200, {
          ready: true,
          email: customerEmail,
          expires_in: CHECKOUT_TOKEN_TTL_SEC,
        })
      },
    },

    {
      path: '/api/signout',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        clearCheckoutCookies(res, env)
        json(200, { ok: true })
      },
    },
  ]
}
