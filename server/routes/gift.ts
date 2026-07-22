// Gift purchase + activation polling.
//
//   POST /api/gift/create-checkout — one-time, payment-mode Checkout Session
//     (ui_mode: 'elements') for any of the three tiers. The buyer is charged the
//     localized gift amount via the catalog gift Price's per-currency
//     currency_options (the session's `currency` selects it) — the same
//     per-currency model as the subscription checkout, replacing the old, inert
//     Adaptive Pricing. Gift metadata (tier/term/currency) is stamped on the
//     underlying PaymentIntent (payment_intent_data) so activation happens on the
//     webhook (payment_intent.succeeded) via the activator.
//   GET  /api/gift/status         — poll for activation. The giver just
//     created this Session moments ago, so an email param matching the
//     Session's giver_email metadata is sufficient proof of ownership (same
//     pattern as /api/stripe/subscription-status).

import { type GiftTerm } from '../lib/activation.js'
import {
  deriveEntitlements,
  syncEntitlement,
  tierFromEntitlements,
  type Tier,
} from '../entitlement.js'
import { isSupportedCurrency, resolveGiftPrice } from '../lib/pricing.js'
import { coerceTier } from './stripe/helpers.js'
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
import { setSessionCookies } from '../lib/cookies.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import {
  getSessionProfile,
  signSessionToken,
  verifyGiftClaimToken,
} from '../lib/session.js'
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
            tier?: string
            term?: GiftTerm
            currency?: string
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

        // Any of the three sellable tiers can be gifted (default Ark+). Currency
        // selects which currency_options amount the gift price charges; an
        // unsupported (or absent) currency falls back to USD, parity with the
        // subscription checkout.
        const tier = coerceTier(body.tier)
        const requestedCurrency = (body.currency ?? '').toLowerCase()
        const currency = isSupportedCurrency(requestedCurrency) ? requestedCurrency : 'usd'

        const wait = giftLimiter.take(giverEmail)
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, {
            error: 'Too many gift attempts. Please wait a moment and try again.',
          })
        }

        const term = body.term
        const termLabel = term === '6mo' ? '6 months' : '1 year'

        // The one-time gift price for this tier+term from the catalog. It carries
        // the per-currency currency_options the session's `currency` selects, so
        // the buyer is charged the localized gift amount (not USD via the old,
        // inert Adaptive Pricing). `amountCents` is the charge-currency amount,
        // used only to rank promos.
        const gift = await resolveGiftPrice(stripe, tier, term)
        const amountCents = gift.floors[currency]

        // Auto-apply the best active promo to gifts too. Per product decision,
        // any auto-apply coupon qualifies regardless of its plan target, so we
        // pass plan=null (a gift has no monthly/yearly plan). Ranked in the charge
        // currency (a foreign-currency amount_off coupon can't apply). The
        // discount is optional, so a lookup failure must never block checkout:
        // log and charge full price.
        let discountCoupon: string | null = null
        try {
          const best = pickBestCoupon(await listActiveCoupons(stripe), null, amountCents, currency)
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
          // Selects which currency_options amount the gift price charges.
          currency,
          // The persistent one-time gift Price (its currency_options carry every
          // supported currency). Fixed amount — no PWYC uplift, so no inline
          // price_data — and reusing the catalog Price avoids the product sprawl
          // the old product_data-per-checkout pattern caused.
          line_items: [{ price: gift.priceId, quantity: 1 }],
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
              tier,
              term,
              currency,
              amount_cents: String(amountCents),
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
          tier,
          term,
          currency,
        })
      },
    }),

    defineRoute({
      path: '/api/gift/status',
      handler: async (req, _res, json) => {
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
      handler: async (req, _res, json) => {
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

        const result = await redeemGiftForRecipient(
          { sql, stripe, env, activator },
          gift,
          { email: session.email, name: session.name, auth0Sub },
        )
        if (!result.ok) return json(409, { error: result.error })
        return json(200, {
          redeemed: true,
          applied: result.applied,
          expires_at: result.expiresAt,
        })
      },
    }),

    defineRoute({
      // The single-email magic link lands here (POSTed by the /redeem confirm
      // page carrying its `mt` token). One call creates/logs-in the recipient
      // and redeems — the whole gift flow in one click, no Auth0 redirect and no
      // "verify your email". The confirm-page indirection (vs. a bare GET link)
      // keeps email link-scanners that auto-open links from consuming the gift
      // before the real recipient clicks.
      path: '/api/gift/claim',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })
        if (!stripe) return json(500, { error: 'not_configured' })
        if (!env.DATABASE_URL) return json(500, { error: 'database_not_configured' })

        const body = await readJson<{ mt?: string }>(req)
        const mt = typeof body?.mt === 'string' ? body.mt.trim() : ''
        if (!mt) return json(400, { error: 'token required' })

        const claim = await verifyGiftClaimToken(mt, env)
        if (!claim) return json(400, { error: 'expired_link' })

        const sql = getDb(env)
        const gift = await getGiftByToken(sql, claim.giftToken)
        if (!gift) return json(404, { error: 'invalid_gift' })
        // Not pending → already claimed. Do NOT mint a session here: a spent
        // magic link must not double as a standing login credential.
        if (gift.status !== 'pending') return json(409, { error: 'already_redeemed' })

        // Provision the recipient's Auth0 login now — pre-verified, since
        // clicking a link delivered to their inbox proves control of the
        // address (and pre-verifying suppresses Auth0's own verification email).
        // This is the ONLY account-provisioning point in the gift flow — nothing
        // is created at purchase — so exactly one email ever reaches the
        // recipient. An existing account is found, not recreated.
        const auth0 = await findOrCreateAuth0User(claim.email, claim.name, env, {
          emailPasswordReset: false,
          emailVerified: true,
        })
        const auth0Sub = auth0?.userId ?? null
        if (!auth0Sub) return json(502, { error: 'could_not_resolve_account' })

        const result = await redeemGiftForRecipient(
          { sql, stripe, env, activator },
          gift,
          { email: claim.email, name: claim.name, auth0Sub },
        )
        if (!result.ok) return json(409, { error: result.error })

        // Log them straight in — mint the same ark_session the OAuth callback
        // would, so they land on /welcome already authenticated. Roles are empty:
        // a gift recipient is never an admin.
        const sessionToken = await signSessionToken(
          { email: claim.email, roles: [], name: claim.name, sub: auth0Sub },
          env,
        )
        setSessionCookies(res, sessionToken, env)

        return json(200, {
          redeemed: true,
          applied: result.applied,
          expires_at: result.expiresAt,
        })
      },
    }),
  ]
}

// The per-axis core of a redemption, shared by the session-authenticated POST
// /api/gift/redeem and the magic-link POST /api/gift/claim. The caller has
// already loaded a PENDING gift and resolved the recipient's Auth0 sub.
//
// The gift covers one or both entitlement axes (Bundle → both). For each covered
// axis (D4/D5):
//   - the recipient already holds it via a LIVE PAID SUBSCRIPTION → credit that
//     axis (they'd otherwise double-pay for a gifted axis);
//   - otherwise → grant/extend a gift term on that axis (stacking onto any live
//     gift term on the same axis).
// Bundle-on-Ark+-subscriber therefore grants a Circle term AND credits the Ark+
// overlap. The gift flips to redeemed once, atomically.
async function redeemGiftForRecipient(
  {
    sql,
    stripe,
    env,
    activator,
  }: {
    sql: ReturnType<typeof getDb>
    stripe: Stripe
    env: Deps['env']
    activator: Deps['activator']
  },
  gift: GiftRow,
  recipient: { email: string; name?: string; auth0Sub: string },
): Promise<
  | { ok: true; applied: 'credit' | 'membership' | 'mixed'; expiresAt?: string }
  | { ok: false; error: 'already_redeemed' }
> {
  const { email, name, auth0Sub } = recipient
  const token = gift.redemption_token
  const now = Date.now()

  // The axes this gift grants (Bundle → both).
  const covered = deriveEntitlements(gift.tier)

  const existing = await getMembershipByAuth0Sub(sql, auth0Sub)
  // A live PAID subscription (a row with a real Stripe sub + customer) already
  // covering an axis diverts THAT axis to credit. A gift-only or expired row
  // never diverts — its axes fall through to a fresh/extended gift term.
  const hasPaidSub =
    existing != null &&
    existing.stripe_subscription_id != null &&
    existing.stripe_customer_id != null &&
    LIVE_MEMBERSHIP_STATUSES.has(existing.status)
  const subAxes = hasPaidSub
    ? deriveEntitlements(existing.tier)
    : { arkPlus: false, circle: false }

  // Per axis: grant where the paid sub doesn't already cover it (extending any
  // live gift term on that axis); credit where it does.
  const grantArkPlus = covered.arkPlus && !subAxes.arkPlus
  const grantCircle = covered.circle && !subAxes.circle
  const creditArkPlus = covered.arkPlus && subAxes.arkPlus
  const creditCircle = covered.circle && subAxes.circle

  // Claim first — the credit branch is not idempotent, so the atomic flip guards
  // a double-redeem race. The grant branch is idempotent (SC/Circle keyed), so
  // flipping first is safe for it too.
  const claimed = await markGiftRedeemed(sql, token, auth0Sub)
  if (!claimed) return { ok: false, error: 'already_redeemed' }

  const term: GiftTerm = gift.plan === '6mo' || gift.plan === '1yr' ? gift.plan : '1yr'

  // Stacking: each granted axis's term starts at its current gift expiry when
  // that is still in the future, else now.
  const arkPlusExistingMs = existing?.ark_plus_gift_expires_at
    ? Date.parse(existing.ark_plus_gift_expires_at)
    : 0
  const circleExistingMs = existing?.circle_gift_expires_at
    ? Date.parse(existing.circle_gift_expires_at)
    : 0
  const arkPlusFromMs = grantArkPlus ? (arkPlusExistingMs > now ? arkPlusExistingMs : now) : null
  const circleFromMs = grantCircle ? (circleExistingMs > now ? circleExistingMs : now) : null

  let grant: {
    scUserId: number | null
    scSubscriptionId: number | null
    arkPlusEndsAt: string | null
    circleEndsAt: string | null
  } = { scUserId: null, scSubscriptionId: null, arkPlusEndsAt: null, circleEndsAt: null }
  if (grantArkPlus || grantCircle) {
    grant = await activator.activateGiftForRecipient({
      email,
      name,
      auth0Sub,
      term,
      arkPlusFromMs,
      circleFromMs,
    })
  }

  // The row's tier column: keep the subscribed tier for a paid-sub row (liveAxes
  // unions it with the gift axes at read time); for a gift-only row, derive from
  // all live gift axes after this grant. A null per-axis expiry below is
  // preserved by the upsert's coalesce, so a single-axis gift never clears the
  // other axis's term or a live subscription's fields.
  let rowTier: Tier
  if (hasPaidSub) {
    rowTier = existing.tier
  } else {
    const arkLive = grant.arkPlusEndsAt != null || arkPlusExistingMs > now
    const circleLive = grant.circleEndsAt != null || circleExistingMs > now
    rowTier = tierFromEntitlements({ arkPlus: arkLive, circle: circleLive })
  }

  await upsertMembership(sql, {
    auth0_sub: auth0Sub,
    stripe_customer_id: existing?.stripe_customer_id ?? null,
    stripe_subscription_id: existing?.stripe_subscription_id ?? null,
    sc_user_id: grant.scUserId, // coalesced with any existing in the upsert
    tier: rowTier,
    status: hasPaidSub ? existing.status : 'active',
    plan: hasPaidSub ? existing.plan : gift.plan,
    amount_cents: hasPaidSub ? existing.amount_cents : gift.amount_cents,
    current_period_end: existing?.current_period_end ?? null,
    cancel_at: existing?.cancel_at ?? null,
    ark_plus_gift_expires_at: grant.arkPlusEndsAt,
    circle_gift_expires_at: grant.circleEndsAt,
  })

  // Paid-sub overlap credit (D5): the gift amount minus the standalone gift price
  // of each GRANTED axis for the term, in the gift's currency, clamped to
  // [0, amount]. All covered axes overlapping a paid sub → nothing granted →
  // full amount credited.
  let creditApplied = false
  if ((creditArkPlus || creditCircle) && hasPaidSub && gift.amount_cents != null) {
    const raw = (gift.currency ?? 'usd').toLowerCase()
    const currency = isSupportedCurrency(raw) ? raw : 'usd'
    let grantedValue = 0
    if (grantArkPlus) grantedValue += (await resolveGiftPrice(stripe, 'ark-plus', term)).floors[currency]
    if (grantCircle) grantedValue += (await resolveGiftPrice(stripe, 'circle', term)).floors[currency]
    const creditCents = Math.max(0, Math.min(gift.amount_cents, gift.amount_cents - grantedValue))
    if (creditCents > 0) {
      try {
        await applyGiftAsCredit(stripe, existing, creditCents, currency)
        creditApplied = true
      } catch (err) {
        console.error('[gift] credit apply failed:', err)
      }
    }
  }

  // Mirror the Circle access group + Beehiiv premium letter to the recipient's
  // FULL effective tier (subscription ∪ live gift axes) — never just the gift
  // tier, or an Ark+ gift would wrongly strip a Circle they hold via their sub.
  const finalArkPlus = subAxes.arkPlus || grant.arkPlusEndsAt != null || arkPlusExistingMs > now
  const finalCircle = subAxes.circle || grant.circleEndsAt != null || circleExistingMs > now
  const effectiveTier = tierFromEntitlements({ arkPlus: finalArkPlus, circle: finalCircle })
  await syncEntitlement(env, email, effectiveTier)
  if (finalArkPlus) {
    await tryPush('ensure premium (gift redeem)', () =>
      ensureSubscribedWithPremium({ env, sql }, email),
    )
  }

  const grantedAny = grant.arkPlusEndsAt != null || grant.circleEndsAt != null
  const applied = grantedAny && creditApplied ? 'mixed' : creditApplied ? 'credit' : 'membership'
  const expiresAt = grant.arkPlusEndsAt ?? grant.circleEndsAt ?? undefined
  return { ok: true, applied, expiresAt }
}

// Apply an unwasted gift portion as Stripe customer-balance credit on the
// recipient's existing customer — auto-drawn against future invoices like a
// voucher (D5). Credited in the gift's currency (its amount_cents denomination);
// a recipient whose subscription bills in a different currency is an FX
// approximation, and the balance draws only same-currency invoices.
async function applyGiftAsCredit(
  stripe: Stripe,
  membership: MembershipRow,
  amountCents: number,
  currency: string,
): Promise<void> {
  if (!membership.stripe_customer_id || amountCents <= 0) return
  await stripe.customers.createBalanceTransaction(membership.stripe_customer_id, {
    amount: -amountCents, // negative = credit toward future invoices
    currency,
    description: 'Ark gift credit',
  })
}
