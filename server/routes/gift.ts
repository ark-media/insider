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
import { deriveEntitlements, syncEntitlement } from '../entitlement.js'
import { findOrCreateAuth0User } from '../lib/auth0-user.js'
import { ensureSubscribedWithPremium, tryPush } from '../lib/beehiiv-sync.js'
import { getDb } from '../lib/db.js'
import { isSameOrigin, readJson } from '../lib/http.js'
import {
  getGiftByToken,
  getMembershipByAuth0Sub,
  markGiftRedeemed,
  upsertMembership,
  type GiftRow,
  type MembershipRow,
} from '../lib/membership.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { getSessionProfile } from '../lib/session.js'
import { listActiveCoupons, pickBestCoupon } from '../lib/stripe-promos.js'
import type Stripe from 'stripe'

// Membership statuses that count as an active paid membership for the gift
// stacking branch (§7 #8): an already-active recipient gets account credit, an
// inactive one gets a gift term. Mirrors the checkout guard's live set; gift
// rows themselves carry status 'active'.
const LIVE_MEMBERSHIP_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid'])

export function giftRoutes({ env, stripe, appBaseUrl, activator }: Deps): Route[] {
  // Each create-checkout call provisions a Stripe Checkout Session (and its
  // PaymentIntent) and may also create a Stripe customer. Cap per giver email
  // so a scripted caller can't produce thousands of zombie sessions or trigger
  // gift-spam against recipients via the receipt_email Stripe sends.
  const giftLimiter = createRateLimiter({
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })

  return [
    defineRoute({
      path: '/api/gift/create-checkout',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })

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

        // Auto-apply the best active promo to gifts too. Per product decision,
        // any auto-apply coupon qualifies regardless of its plan target, so we
        // pass plan=null (a gift has no monthly/yearly plan). Ranked against the
        // USD source amount; Adaptive Pricing then converts the discounted
        // total. The discount is optional, so a lookup failure must never block
        // checkout: log and charge full price.
        let discountCoupon: string | null = null
        try {
          const best = pickBestCoupon(await listActiveCoupons(stripe), null, amountCents)
          if (best) discountCoupon = best.id
        } catch (err) {
          console.error('[gift] promo lookup failed; charging full price:', err)
        }

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
                // Exclusive: the USD amount is pre-tax; Stripe Tax adds tax on
                // top at checkout. Required once automatic_tax is on — an inline
                // price with no tax_behavior errors under automatic tax.
                tax_behavior: 'exclusive',
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
          // Stripe Tax: compute and add tax on top of the (exclusive) price.
          // Works for one-time payment-mode sessions too; the calculated tax
          // appears in Tax Reports. Requires Stripe Tax active in the Dashboard.
          automatic_tax: { enabled: true },
          // Persist the billing address the giver enters (BillingAddressElement)
          // back onto the pre-set Customer — required when a customer is
          // attached, and it feeds the tax jurisdiction.
          customer_update: { address: 'auto' },
          ...(discountCoupon ? { discounts: [{ coupon: discountCoupon }] } : {}),
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
    }),

    defineRoute({
      path: '/api/gift/status',
      handler: async (req, res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })
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
          // The webhook now writes a pending gift row and stamps the redemption
          // token on the PI (rather than granting immediately) — so "processed"
          // means the recipient's claim link is out, not that access is live.
          activated: Boolean(pi?.metadata?.gift_token),
        })
      },
    }),

    defineRoute({
      // Redeem a gift the recipient received by email. Requires a signed-in
      // session (the claim writes a membership row keyed on the recipient's Auth0
      // sub). Branches on whether they already hold an active paid membership
      // (§3 "Gifts"): none → activate a gift term; already active → apply the
      // gift amount as Stripe account credit. Either way the gift flips to
      // redeemed. No redeem-by — a gift is claimable anytime.
      path: '/api/gift/redeem',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })
        if (!env.DATABASE_URL) return json(500, { error: 'database_not_configured' })

        const session = await getSessionProfile(req, env)
        if (!session) return json(401, { error: 'unauthenticated' })

        const body = await readJson<{ token?: string }>(req)
        const token = typeof body?.token === 'string' ? body.token.trim() : ''
        if (!token) return json(400, { error: 'token required' })

        const sql = getDb(env)
        const gift = await getGiftByToken(sql, token)
        if (!gift) return json(404, { error: 'invalid_gift' })
        if (gift.status !== 'pending') return json(409, { error: 'already_redeemed' })

        // Resolve the recipient's primary Auth0 sub. They're signed in, so this
        // finds the existing account (never creates one here); the membership row
        // keys on it.
        const auth0 = await findOrCreateAuth0User(session.email, session.name, env, {
          emailPasswordReset: false,
        })
        const auth0Sub = auth0?.userId ?? null
        if (!auth0Sub) return json(502, { error: 'could_not_resolve_account' })

        const existing = await getMembershipByAuth0Sub(sql, auth0Sub)
        // Only a real, creditable subscription diverts the gift to account credit.
        // It must have a Stripe customer — applyGiftAsCredit no-ops without one, so
        // routing a gift-only membership (null customer) here flipped the gift to
        // redeemed while granting nothing. A gift-only or expired-gift row instead
        // falls through to a fresh/extended gift term below.
        const canCredit =
          existing != null &&
          existing.stripe_customer_id != null &&
          existing.tier !== 'free' &&
          LIVE_MEMBERSHIP_STATUSES.has(existing.status)

        if (canCredit) {
          // Claim first — account credit is not idempotent, so the atomic flip
          // guards against a double-credit race.
          const claimed = await markGiftRedeemed(sql, token, auth0Sub)
          if (!claimed) return json(409, { error: 'already_redeemed' })
          try {
            await applyGiftAsCredit(stripe, existing, gift)
          } catch (err) {
            console.error('[gift] credit apply failed:', err)
          }
          return json(200, { redeemed: true, applied: 'credit' })
        }

        // Grant a gift term. If the recipient already holds an UNEXPIRED gift
        // term, stack the new term onto the remaining time (start the clock at the
        // current expiry) rather than resetting it to now and dropping the balance.
        const term: GiftTerm = gift.plan === '6mo' || gift.plan === '1yr' ? gift.plan : '1yr'
        const existingGiftMs = existing?.gift_expires_at
          ? Date.parse(existing.gift_expires_at)
          : 0
        const fromMs = existingGiftMs > Date.now() ? existingGiftMs : Date.now()
        const grant = await activator.activateGiftForRecipient({
          email: session.email,
          name: session.name,
          tier: gift.tier,
          term,
          auth0Sub,
          fromMs,
        })
        await upsertMembership(sql, {
          auth0_sub: auth0Sub,
          stripe_customer_id: null,
          stripe_subscription_id: null,
          sc_user_id: grant.scUserId,
          tier: gift.tier,
          status: 'active',
          plan: gift.plan,
          amount_cents: gift.amount_cents,
          current_period_end: null,
          cancel_at: null,
          gift_expires_at: grant.endsAt,
        })
        // Mirror the entitlement signals (Auth0 shim + Circle group) and the
        // Beehiiv premium letter (arkPlus axis only).
        await syncEntitlement(env, session.email, gift.tier)
        if (deriveEntitlements(gift.tier).arkPlus) {
          await tryPush('ensure premium (gift redeem)', () =>
            ensureSubscribedWithPremium({ env, sql }, session.email),
          )
        }
        // Flip last: the grant is idempotent, so a concurrent redeem is harmless.
        await markGiftRedeemed(sql, token, auth0Sub)
        return json(200, { redeemed: true, applied: 'membership', expires_at: grant.endsAt })
      },
    }),
  ]
}

// Apply an unwasted gift as Stripe customer-balance credit on the recipient's
// existing customer — auto-drawn against future invoices like a voucher (§7 #8).
// Credited in the active subscription's currency; gift amounts are USD today, so
// a non-USD sub is an FX approximation (full conversion deferred).
async function applyGiftAsCredit(
  stripe: Stripe,
  membership: MembershipRow,
  gift: GiftRow,
): Promise<void> {
  if (!membership.stripe_customer_id || gift.amount_cents == null) return
  let currency = 'usd'
  if (membership.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(membership.stripe_subscription_id)
      currency = sub.currency ?? 'usd'
    } catch {
      // Fall back to USD — a credit still lands, just possibly mis-denominated.
    }
  }
  await stripe.customers.createBalanceTransaction(membership.stripe_customer_id, {
    amount: -gift.amount_cents, // negative = credit toward future invoices
    currency,
    description: `Ark+ gift credit (${gift.plan ?? 'gift'})`,
  })
}
