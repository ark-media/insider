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

import { GIFT_TERM_DAYS, type GiftTerm } from '../lib/activation.js'
import {
  deriveEntitlements,
  syncEntitlement,
  tierFromEntitlements,
  type Tier,
} from '../entitlement.js'
import { isSupportedCurrency, resolveGiftPrice, type PricedTier } from '../lib/pricing.js'
import { coerceTier, releaseScheduleIfAny } from './stripe/helpers.js'
import { findOrCreateAuth0User } from '../lib/auth0-user.js'
import { ensureSubscribedWithPremium, tryPush } from '../lib/beehiiv-sync.js'
import { getDb } from '../lib/db.js'
import { sanitizeAttribution } from '../../shared/attribution.js'
import { captureServerEvent, emailDistinctId } from '../lib/analytics-server.js'
import { getClientIp, isSameOrigin, readJson } from '../lib/http.js'
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
  // PaymentIntent) and may also create a Stripe customer. The endpoint is
  // unauthenticated by necessity — anonymous buyers must be able to purchase —
  // so the bucket key is the only thing bounding Stripe writes.
  //
  // Two buckets, because keying on the giver email alone did NOT achieve the
  // cap it was written for: `giver_email` is attacker-supplied free text, so
  // every request could mint a fresh bucket just by varying it.
  //   - per email+IP: the intended "one buyer, a few retries" cap.
  //   - per IP: bounds total Stripe writes from one source regardless of how
  //     many identities it invents. Vercel overwrites x-forwarded-for with the
  //     real client IP (it does not forward external values), so this key can't
  //     be spoofed in production.
  const giftLimiter = createRateLimiter({
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })
  const giftIpLimiter = createRateLimiter({
    capacity: 15,
    refillPerSec: 15 / (60 * 60), // 15 per hour per source
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
            attribution?: unknown
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

        const clientIp = getClientIp(req)
        const wait =
          giftIpLimiter.take(clientIp) ?? giftLimiter.take(`${clientIp}|${giverEmail}`)
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
        // inert Adaptive Pricing). `amountCents` is the charge-currency list
        // amount, used only to rank promos here — the row's stored amount comes
        // from the PaymentIntent's actual `amount_received` in the webhook.
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
              giver_email: giverEmail,
              giver_name: body.giver_name ?? '',
              recipient_email: recipientEmail,
              recipient_name: body.recipient_name ?? '',
              message: body.message ?? '',
              // Acquisition channel for the GIVER, forwarded from the browser
              // (BI plan §4.1) so `gift_purchased_confirmed` is attributable.
              // Allowlisted + length-capped — the client is untrusted.
              ...sanitizeAttribution(body.attribution),
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
        if (gift.status !== 'pending') {
          return json(409, {
            error: gift.status === 'void' ? 'gift_voided' : 'already_redeemed',
          })
        }

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
        // Not pending → already claimed, or voided by a refund/dispute. Do NOT
        // mint a session in either case: a spent or reversed magic link must not
        // double as a standing login credential.
        if (gift.status !== 'pending') {
          return json(409, {
            error: gift.status === 'void' ? 'gift_voided' : 'already_redeemed',
          })
        }

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

// A membership row's per-axis fields, as far as the redemption planner cares.
export type GiftRedemptionExisting = {
  tier: Tier
  status: string
  stripe_subscription_id: string | null
  stripe_customer_id: string | null
  ark_plus_gift_expires_at: string | null
  circle_gift_expires_at: string | null
}

// The pure decision core of a redemption: given the gift, the recipient's current
// membership row (or null), and the clock, decide which axes to grant vs credit,
// where each granted axis's term starts (stacking), and what the row/effective
// tiers become. No IO — every branch here is unit-tested (gift-redeem.test.ts) so
// the stacking + grant/credit split can't silently drift.
//
// Overlap with a live paid subscription resolves extend-first (D5):
//   - axis the recipient LACKS → grant/stack a gift term on that axis (start the
//     clock at any live gift expiry, else now);
//   - gift overlaps a SINGLE-AXIS or EXACT-TIER paid sub → EXTEND that sub by the
//     term (defer billing; no balance moves — see extendSubscription / T5.4);
//   - a SINGLE-AXIS gift landing entirely inside a BUNDLE sub → CREDIT the full
//     gift amount (the sole credit path; can't pause part of a bundle).
export type GiftRedemptionPlan = {
  hasPaidSub: boolean
  grantArkPlus: boolean
  grantCircle: boolean
  // Extend the recipient's live subscription by the gift term (D5). True for any
  // overlap that isn't the bundle-subset credit case below.
  extendSub: boolean
  // Credit the FULL gift amount to the customer balance (D5/D10) — reached only
  // when a single-axis gift is fully contained in a Bundle sub.
  creditFull: boolean
  // Epoch ms each granted axis's term is measured from; null = don't grant it.
  arkPlusFromMs: number | null
  circleFromMs: number | null
  // The `tier` column to write: the subscribed tier for a paid-sub row (liveAxes
  // unions it with the gift axes at read time); otherwise the tier derived from
  // all live gift axes after this grant.
  rowTier: Tier
  // The recipient's FULL effective tier after redemption (subscription ∪ live
  // gift axes) — drives the Circle-group / Beehiiv mirror so an Ark+ gift never
  // strips a Circle the recipient holds via their subscription.
  effectiveTier: Tier
}

export function planGiftRedemption(
  gift: { tier: Tier },
  existing: GiftRedemptionExisting | null,
  now: number,
): GiftRedemptionPlan {
  const covered = deriveEntitlements(gift.tier)

  // A live PAID subscription (a row with a real Stripe sub + customer) already
  // covering an axis diverts THAT axis to credit. A gift-only or expired row
  // never diverts — its axes fall through to a fresh/extended gift term.
  const hasPaidSub =
    existing != null &&
    existing.stripe_subscription_id != null &&
    existing.stripe_customer_id != null &&
    LIVE_MEMBERSHIP_STATUSES.has(existing.status)
  const subAxes =
    hasPaidSub && existing != null
      ? deriveEntitlements(existing.tier)
      : { arkPlus: false, circle: false }

  const grantArkPlus = covered.arkPlus && !subAxes.arkPlus
  const grantCircle = covered.circle && !subAxes.circle

  // Overlap between the gift and the paid sub (D5, extend-first). A single-axis
  // gift fully inside a Bundle sub is the ONLY credit case; every other overlap
  // (single-axis sub, or bundle-on-bundle exact-tier) extends the sub instead.
  const overlap = (covered.arkPlus && subAxes.arkPlus) || (covered.circle && subAxes.circle)
  const subIsBundle = subAxes.arkPlus && subAxes.circle
  const giftIsSingleAxis = !(covered.arkPlus && covered.circle)
  const creditFull = overlap && giftIsSingleAxis && subIsBundle
  const extendSub = overlap && !creditFull

  const arkPlusExistingMs = existing?.ark_plus_gift_expires_at
    ? Date.parse(existing.ark_plus_gift_expires_at)
    : 0
  const circleExistingMs = existing?.circle_gift_expires_at
    ? Date.parse(existing.circle_gift_expires_at)
    : 0
  const arkPlusFromMs = grantArkPlus ? (arkPlusExistingMs > now ? arkPlusExistingMs : now) : null
  const circleFromMs = grantCircle ? (circleExistingMs > now ? circleExistingMs : now) : null

  // A granted axis is live after this redemption; so is a not-granted axis whose
  // existing gift term is still in the future.
  const arkLiveAfter = grantArkPlus || arkPlusExistingMs > now
  const circleLiveAfter = grantCircle || circleExistingMs > now

  const rowTier =
    hasPaidSub && existing != null
      ? existing.tier
      : tierFromEntitlements({ arkPlus: arkLiveAfter, circle: circleLiveAfter })
  const effectiveTier = tierFromEntitlements({
    arkPlus: subAxes.arkPlus || arkLiveAfter,
    circle: subAxes.circle || circleLiveAfter,
  })

  return {
    hasPaidSub,
    grantArkPlus,
    grantCircle,
    extendSub,
    creditFull,
    arkPlusFromMs,
    circleFromMs,
    rowTier,
    effectiveTier,
  }
}

// The IO core of a redemption, shared by the session-authenticated POST
// /api/gift/redeem and the magic-link POST /api/gift/claim. The caller has
// already loaded a PENDING gift and resolved the recipient's Auth0 sub. Decision
// logic lives in planGiftRedemption above; this function performs the grant, the
// atomic claim, the row upsert, the overlap extend/credit, and the entitlement
// mirror.
//
// Bundle-on-Ark+-subscriber grants a Circle term AND extends the Ark+ sub by the
// term. The gift flips to redeemed once, atomically.
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
  | { ok: true; applied: 'credit' | 'membership' | 'mixed' | 'extended'; expiresAt?: string }
  | { ok: false; error: 'already_redeemed' }
> {
  const { email, name, auth0Sub } = recipient
  const token = gift.redemption_token
  const now = Date.now()

  const existing = await getMembershipByAuth0Sub(sql, auth0Sub)
  const plan = planGiftRedemption(gift, existing, now)
  const term: GiftTerm = gift.plan === '6mo' || gift.plan === '1yr' ? gift.plan : '1yr'

  // Grant FIRST, before the atomic claim. The grant is idempotent (SC keyed by
  // recipient+axis, Circle group-add is a no-op if present), so a concurrent
  // redeem that also grants is harmless — but if it THROWS (SC/Circle outage) the
  // gift is still PENDING and the recipient can retry. Claiming first (the old
  // order) would burn the gift on any transient provisioning failure.
  let grant: {
    scUserId: number | null
    scSubscriptionId: number | null
    arkPlusEndsAt: string | null
    circleEndsAt: string | null
  } = { scUserId: null, scSubscriptionId: null, arkPlusEndsAt: null, circleEndsAt: null }
  if (plan.grantArkPlus || plan.grantCircle) {
    grant = await activator.activateGiftForRecipient({
      email,
      name,
      auth0Sub,
      term,
      giftToken: token,
      arkPlusFromMs: plan.arkPlusFromMs,
      circleFromMs: plan.circleFromMs,
    })
  }

  // Claim now — this atomic flip gates the non-idempotent credit below and the
  // row upsert. A lost race means another redeem already granted (idempotent) and
  // upserted, so bail without touching the row or crediting twice.
  const claimed = await markGiftRedeemed(sql, token, auth0Sub)
  if (!claimed) return { ok: false, error: 'already_redeemed' }

  // The row's per-axis expiries. A null is preserved by the upsert's coalesce, so
  // a single-axis gift never clears the other axis's term or a live sub's fields.
  await upsertMembership(sql, {
    auth0_sub: auth0Sub,
    stripe_customer_id: existing?.stripe_customer_id ?? null,
    stripe_subscription_id: existing?.stripe_subscription_id ?? null,
    sc_user_id: grant.scUserId, // coalesced with any existing in the upsert
    tier: plan.rowTier,
    status: plan.hasPaidSub && existing != null ? existing.status : 'active',
    plan: plan.hasPaidSub && existing != null ? existing.plan : gift.plan,
    amount_cents: plan.hasPaidSub && existing != null ? existing.amount_cents : gift.amount_cents,
    current_period_end: existing?.current_period_end ?? null,
    cancel_at: existing?.cancel_at ?? null,
    ark_plus_gift_expires_at: grant.arkPlusEndsAt,
    circle_gift_expires_at: grant.circleEndsAt,
  })

  // Paid-sub overlap (D5, extend-first). Two mutually-exclusive mechanics:
  //   - extendSub → defer the recipient's live sub by the gift term (term-faithful:
  //     pause monthly / push the annual period). No balance moves.
  //   - creditFull → a single-axis gift fully inside a Bundle sub: nothing to grant
  //     or extend, so credit the gift back to the customer balance.
  //
  //     Credit what was actually PAID (`gift.amount_cents`, captured from the
  //     PaymentIntent's amount_received), never the catalog list price. Crediting
  //     list turned any auto-apply promo — and the spread between per-currency
  //     purchasing-power floors — into free balance: buy discounted, redeem
  //     against your own Bundle sub, collect the undiscounted amount. Capped at
  //     list so a mis-stamped row can't over-credit.
  //
  //     A Stripe balance only draws invoices of its own currency, so a gift paid
  //     in another currency can't be credited here without inventing an FX rate.
  //     Skip rather than guess — the gift still granted/extended above.
  let extended = false
  let creditApplied = false
  if (plan.extendSub && existing?.stripe_subscription_id) {
    try {
      await extendSubscription(stripe, env, existing.stripe_subscription_id, term)
      extended = true
    } catch (err) {
      console.error('[gift] subscription extend failed:', err)
    }
  } else if (plan.creditFull && existing != null) {
    const subCur = await subscriptionCurrency(stripe, existing)
    const currency = isSupportedCurrency(subCur) ? subCur : 'usd'
    // A gift row's tier is always a priced tier (never 'free').
    const list = (await resolveGiftPrice(stripe, gift.tier as PricedTier, term)).floors[currency]
    const creditCents = giftCreditCents({
      paidCents: gift.amount_cents,
      listCents: list ?? 0,
      giftCurrency: gift.currency,
      subscriptionCurrency: currency,
    })
    if (creditCents === null) {
      console.error('[gift] credit skipped — currency mismatch or no captured amount', {
        giftCurrency: gift.currency,
        subscriptionCurrency: currency,
        amountCents: gift.amount_cents,
      })
    } else {
      try {
        await applyGiftAsCredit(stripe, existing, creditCents, currency)
        creditApplied = true
      } catch (err) {
        console.error('[gift] credit apply failed:', err)
      }
    }
  }

  // Mirror the Circle access group + Beehiiv premium letter to the recipient's
  // FULL effective tier (subscription ∪ live gift axes), never just the gift tier.
  await syncEntitlement(env, email, plan.effectiveTier)
  if (deriveEntitlements(plan.effectiveTier).arkPlus) {
    await tryPush('ensure premium (gift redeem)', () =>
      ensureSubscribedWithPremium({ env, sql }, email),
    )
  }

  // Report what actually happened: 'membership' when a fresh term was granted,
  // 'extended' when only a live sub was deferred, 'mixed' when both (bundle gift
  // on a single-axis sub), 'credit' for the bundle-subset case. Never claim a
  // membership was created when only a sub was extended or credit applied.
  const grantedAny = grant.arkPlusEndsAt != null || grant.circleEndsAt != null
  const applied: 'credit' | 'membership' | 'mixed' | 'extended' = creditApplied
    ? 'credit'
    : grantedAny && extended
      ? 'mixed'
      : extended
        ? 'extended'
        : 'membership'
  const expiresAt = grant.arkPlusEndsAt ?? grant.circleEndsAt ?? undefined

  // Closes the gift loop server-side (BI plan §4.2). The client already fires
  // `gift_redeemed`, but the magic-link path auto-logs the recipient in and
  // redeems server-side, so a redemption can complete with no browser event at
  // all. Paired with `gift_purchased_confirmed` this gives the purchase →
  // redemption rate, and keys the recipient — not the giver — so the follow-on
  // question ("does a gift recipient convert to paid?") is answerable.
  await captureServerEvent(env, {
    event: 'gift_redeemed_confirmed',
    distinctId: emailDistinctId(email),
    properties: { tier: plan.rowTier, plan: gift.plan ?? null, applied },
  })

  return { ok: true, applied, expiresAt }
}

// T5.4 — extend a live subscription by a gift term, term-faithfully (a year is a
// year regardless of the recipient's rate). Monthly subs PAUSE collection for the
// term (invoices during the window stay drafts, access continues, Stripe
// auto-resumes at resumes_at); annual subs get their current period PUSHED out by
// the term via trial_end (the renewal date visibly moves; a bare pause would only
// skip a cycle). Never moves the customer balance — that's the credit path
// (D5/D10). The resulting subscription.updated is a no-op for entitlement: same
// tier + already-provisioned sub → the webhook's diff-gate skips fan-out/revoke.
async function extendSubscription(
  stripe: Stripe,
  env: Deps['env'],
  subscriptionId: string,
  term: GiftTerm,
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId)
  // A pending period-end change (attached schedule) makes Stripe reject a plain
  // subscriptions.update — detach it first, then extend on the current phase.
  await releaseScheduleIfAny(stripe, sub, env)
  const termMs = GIFT_TERM_DAYS[term] * 24 * 60 * 60 * 1000
  const item = sub.items.data[0]
  if (item?.price?.recurring?.interval === 'year') {
    // Push the renewal: trial_end = current period end + term, no proration, so
    // no charge lands now and billing resumes at the moved-out date.
    const periodEndSec = item.current_period_end ?? Math.floor(Date.now() / 1000)
    const newEndSec = Math.floor((periodEndSec * 1000 + termMs) / 1000)
    await stripe.subscriptions.update(subscriptionId, {
      trial_end: newEndSec,
      proration_behavior: 'none',
    })
  } else {
    // Monthly (or any non-annual cadence) → pause collection for the term.
    const resumesAtSec = Math.floor((Date.now() + termMs) / 1000)
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: { behavior: 'keep_as_draft', resumes_at: resumesAtSec },
    })
  }
}

// The billing currency of the recipient's live subscription — the only currency a
// customer-balance credit can be drawn against. Falls back to USD if the sub
// can't be read (a credit still lands; worst case it's mis-denominated, same as
// the old behavior).
async function subscriptionCurrency(
  stripe: Stripe,
  membership: MembershipRow,
): Promise<string> {
  if (!membership.stripe_subscription_id) return 'usd'
  try {
    const sub = await stripe.subscriptions.retrieve(membership.stripe_subscription_id)
    return (sub.currency ?? 'usd').toLowerCase()
  } catch {
    return 'usd'
  }
}

// How much customer balance a fully-overlapped gift is worth, or null when it
// can't be credited safely. Split out from the redeem handler so the invariant
// that matters — you get back what you PAID, never the catalog list price — is
// directly testable.
//
// Crediting list was a money bug: gift checkout auto-applies any active coupon
// and lets the buyer pick any supported presentment currency, whose floors are
// purchasing-power presets rather than FX-equivalent. Buying low and redeeming
// against your own Bundle sub then minted the difference as balance.
export function giftCreditCents(opts: {
  paidCents: number | null
  listCents: number
  giftCurrency: string | null
  subscriptionCurrency: string
}): number | null {
  const gift = (opts.giftCurrency ?? 'usd').toLowerCase()
  // A Stripe balance only offsets invoices in its own currency, so crossing
  // currencies here would require inventing an FX rate. Refuse instead.
  if (gift !== opts.subscriptionCurrency.toLowerCase()) return null
  const paid = opts.paidCents ?? 0
  if (paid <= 0 || opts.listCents <= 0) return null
  return Math.min(paid, opts.listCents)
}

// Apply an unwasted gift portion as Stripe customer-balance credit on the
// recipient's existing customer — auto-drawn against future invoices like a
// voucher (D5). Denominated in the subscription's billing currency (resolved by
// the caller via subscriptionCurrency) so the balance actually draws.
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
