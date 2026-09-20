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
import { MAX_NAME_LEN, coerceTier, releaseScheduleIfAny } from './stripe/helpers.js'
import { findOrCreateAuth0User } from '../lib/auth0-user.js'
import {
  downgradeToFree,
  ensureSubscribedWithPremium,
  tryPush,
} from '../lib/beehiiv-sync.js'
import { resolveEntitlementsForSub } from '../lib/entitlement-resolver.js'
import { getDb } from '../lib/db.js'
import { sanitizeAttribution } from '../../shared/attribution.js'
import { isValidEmail } from '../../shared/validation.js'
import { splitFullName } from '../../shared/profile-name.js'
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
import { createSharedRateLimiter } from '../lib/shared-rate-limit.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import {
  getSessionProfile,
  resolveRequestIdentity,
  sessionName,
  signSessionToken,
  verifyGiftClaimToken,
} from '../lib/session.js'
import type Stripe from 'stripe'

// Membership statuses that count as an active paid membership for the gift
// stacking branch (§7 #8): an already-active recipient gets account credit, an
// inactive one gets a gift term. Mirrors the checkout guard's live set; gift
// rows themselves carry status 'active'.
const LIVE_MEMBERSHIP_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid'])

// Characters with no place in a name: the C0/C1 controls, the Unicode line and
// paragraph separators, and the bidi marks/overrides that make one string
// display as another. The same class /api/account/profile refuses (see
// CONTROL_CHARS in routes/account.ts for why it is not all of \p{Cf}). Both gift
// names travel further than a profile name does — into Stripe metadata, a
// Customer record, and an email sent from our domain to an address the buyer
// chose — so they are refused here rather than cleaned up downstream.
const NAME_CONTROL_CHARS =
  /[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u

// A gift name as the rest of the flow should see it, or null when it can't be
// accepted. Absent and blank are both fine (names are optional) and come back
// as ''. Checked BEFORE trimming or collapsing anything: whitespace handling
// would quietly rewrite an embedded newline into a space and turn a
// header-injection attempt into a plausible name.
function cleanGiftName(raw: unknown): string | null {
  if (raw == null) return ''
  if (typeof raw !== 'string') return null
  if (NAME_CONTROL_CHARS.test(raw)) return null
  const value = raw.trim()
  return value.length > MAX_NAME_LEN ? null : value
}

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
  //
  // Shared (Neon-backed) rather than in-process: an in-memory bucket is one per
  // function instance and empties on a cold start, so a script fanned out across
  // instances multiplied both caps.
  const giftLimiter = createSharedRateLimiter(env, {
    name: 'gift-checkout-email',
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })
  const giftIpLimiter = createSharedRateLimiter(env, {
    name: 'gift-checkout-ip',
    capacity: 15,
    refillPerSec: 15 / (60 * 60), // 15 per hour per source
  })
  // The status poll retrieves a Checkout Session from Stripe on every call, and
  // it does so BEFORE it can know whether the caller owns that session — the
  // ownership proof is on the session. So an anonymous loop over it is a loop
  // over the Stripe API on our key. The gift modal polls once a second and
  // gives up after 15 attempts, so one purchase spends 15 tokens at most; the
  // bucket holds four purchases' worth for a shared address (an office NAT)
  // and refills a whole purchase every 30 seconds.
  const giftStatusLimiter = createSharedRateLimiter(env, {
    name: 'gift-status-ip',
    capacity: 60,
    refillPerSec: 0.5,
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
        // Same checks the subscription checkout applies to its one address and
        // name, on all four of ours. Both addresses get mail from our domain on
        // the strength of this request alone (a receipt, a claim link), and both
        // names are printed in it.
        if (!isValidEmail(giverEmail)) {
          return json(400, { error: 'Please enter a valid email.' })
        }
        if (!isValidEmail(recipientEmail)) {
          return json(400, { error: "Please enter a valid email for the recipient." })
        }
        const giverName = cleanGiftName(body.giver_name)
        const recipientName = cleanGiftName(body.recipient_name)
        if (giverName === null) return json(400, { error: 'Your name is not valid.' })
        if (recipientName === null) {
          return json(400, { error: "The recipient's name is not valid." })
        }
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
          (await giftIpLimiter.take(clientIp)) ??
          (await giftLimiter.take(`${clientIp}|${giverEmail}`))
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
        // inert Adaptive Pricing). The row's stored amount comes from the
        // PaymentIntent's actual `amount_received` in the webhook, so a promo
        // code the giver redeems is reflected there and nowhere else.
        const gift = await resolveGiftPrice(stripe, tier, term)

        // An existing Customer is reused only for a caller who is durably
        // signed in AS the giver address. `giver_email` is otherwise free text
        // from an anonymous form, and a Customer is not a neutral container: it
        // holds a saved card, a balance (a credited gift lands there), a billing
        // address and an invoice history. Attaching a stranger's Session to one
        // on the strength of knowing its email hands them a view of that — and
        // `customer_update.address` below would then let them overwrite its
        // billing address, which is what Stripe Tax reads for the owner's own
        // renewals.
        //
        // `source === 'auth0'` is the durable login; a 'checkout' identity is
        // the short-lived token minted from an address typed into a checkout
        // form, which proves nothing about the inbox. Everyone else gets a fresh
        // Customer. The duplicate is the cheap side of the trade — every lookup
        // in the app already copes with several Customers per email.
        //
        // giverEmail is already lowercased, which matters to the lookup:
        // `customers.list({ email })` is an exact, case-sensitive match.
        const identity = await resolveRequestIdentity(req, env)
        const isGiver =
          identity?.source === 'auth0' &&
          identity.email.trim().toLowerCase() === giverEmail
        const owned = isGiver
          ? (await stripe.customers.list({ email: giverEmail, limit: 1 })).data[0]
          : undefined
        const customer =
          owned ??
          (await stripe.customers.create({
            email: giverEmail,
            name: giverName || undefined,
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
          // price_data — and reusing the catalog Price keeps one product per
          // gift SKU.
          line_items: [{ price: gift.priceId, quantity: 1 }],
          // Stripe Tax: compute and add tax on top of the (exclusive) price.
          // Works for one-time payment-mode sessions too; the calculated tax
          // appears in Tax Reports. Requires Stripe Tax active in the Dashboard.
          automatic_tax: { enabled: true },
          // Persist the billing address the giver enters (BillingAddressElement)
          // back onto the pre-set Customer — required when a customer is
          // attached, and it feeds the tax jurisdiction. Safe to write through
          // because `customer` is only ever one this call just created or the
          // signed-in giver's own (see above) — never one found by email alone.
          customer_update: { address: 'auto' },
          // Gift buyers get the same promo-code field as members, so the
          // Session carries `allow_promotion_codes` rather than a server-set
          // `discounts` array (Stripe rejects both together). The house sale is
          // applied by code in the browser — any auto-apply coupon qualifies
          // for a gift regardless of its plan target, which is what
          // /api/promo/active?term= resolves.
          allow_promotion_codes: true,
          // Stamp the PaymentIntent so the existing webhook
          // (payment_intent.succeeded, kind:'gift') activates the grant +
          // entitlement unchanged — the Session is just the funnel that
          // creates it.
          payment_intent_data: {
            receipt_email: giverEmail,
            description: `Ark Insider gift · ${termLabel}`,
            metadata: {
              kind: 'gift',
              tier,
              term,
              currency,
              giver_email: giverEmail,
              giver_name: giverName,
              recipient_email: recipientEmail,
              recipient_name: recipientName,
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
      handler: async (req, res, json) => {
        if (!stripe) return json(500, { error: 'not_configured' })
        const url = new URL(req.url ?? '/', appBaseUrl)
        const sessionId = url.searchParams.get('id')
        if (!sessionId) return json(400, { error: 'id required' })

        // After the cheap validation, before the Stripe call it exists to bound.
        const wait = await giftStatusLimiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'Too many requests. Please wait a moment.' })
        }

        const emailParam = url.searchParams.get('email')?.trim().toLowerCase()
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['payment_intent'],
        })
        const giver = session.metadata?.giver_email?.toLowerCase()
        if (!emailParam || !giver || emailParam !== giver) {
          return json(403, { error: 'Forbidden' })
        }

        // The PaymentIntent carries the live status the webhook stamps on
        // activation.
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
        const auth0 = await findOrCreateAuth0User(session.email, sessionName(session), env)
        const auth0Sub = auth0?.userId ?? null
        if (!auth0Sub) return json(502, { error: 'could_not_resolve_account' })

        const result = await redeemGiftForRecipient(
          { sql, stripe, env, activator },
          gift,
          { email: session.email, name: sessionName(session), auth0Sub },
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
        // The claim token carries the single name the giver typed for the
        // recipient; split it so the session speaks the same first/last shape as
        // every other login path.
        const claimName = splitFullName(claim.name)
        const sessionToken = await signSessionToken(
          {
            email: claim.email,
            roles: [],
            givenName: claimName.first,
            familyName: claimName.last,
            sub: auth0Sub,
            // A session bought with an emailed link, like the lifecycle emails'
            // auto-login: enough to land signed in and set up feeds, not enough
            // to change billing until they sign in for real (guards.ts).
            via: 'email_link',
          },
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
//
// Exported for the race test (gift-redeem-race.test.ts); the routes above are
// its only callers.
export async function redeemGiftForRecipient(
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

  // Grant FIRST, before the atomic claim. The grant is idempotent (the Beehiiv
  // premium tier is a boolean, the Circle group-add a no-op if present), so a
  // concurrent redeem that also grants is harmless — but if it THROWS (a
  // Beehiiv/Circle outage) the gift is still PENDING and the recipient can
  // retry. Claiming first would burn the gift on any transient
  // provisioning failure.
  let grant: {
    arkPlusEndsAt: string | null
    circleEndsAt: string | null
  } = { arkPlusEndsAt: null, circleEndsAt: null }
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
  if (!claimed) {
    await undoLostRaceGrant({ sql, env }, token, recipient, plan)
    return { ok: false, error: 'already_redeemed' }
  }

  // The row's per-axis expiries. A null is preserved by the upsert's coalesce, so
  // a single-axis gift never clears the other axis's term or a live sub's fields.
  await upsertMembership(sql, {
    auth0_sub: auth0Sub,
    stripe_customer_id: existing?.stripe_customer_id ?? null,
    stripe_subscription_id: existing?.stripe_subscription_id ?? null,
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

// Take back what a redeem granted before it lost the claim.
//
// Granting before claiming is deliberate (see above) and has one cost: the call
// that loses `markGiftRedeemed` has already put its recipient on Beehiiv premium
// and/or in the Circle group, with no membership row behind either. Nothing else
// notices until the nightly reconciler, so for up to a day a bearer of someone
// else's gift token keeps the feed for the price of losing a race — and the race
// is theirs to stage.
//
// Who won decides what "undo" means:
//   - the SAME account (a double-click, a retried request, two tabs): the grant
//     this call made IS the winner's grant, idempotently. Taking it back would
//     strip a recipient of the gift they just redeemed, and reading their row to
//     find out isn't safe either — the winner upserts it AFTER claiming, so from
//     here it may not exist yet. `redeemed_by` is written by the claim itself,
//     which is why it is what's read.
//   - anyone else (or the gift was voided mid-flight): the winner's redemption
//     never touches this account's row, so the row is the truth. Re-sync each
//     axis THIS call granted to what the row says, and no other — an axis the
//     loser holds through their own subscription or an earlier gift stays.
//
// Best effort. The caller is answering 409 regardless, and a failure here leaves
// exactly the state the reconciler already exists to clean up.
async function undoLostRaceGrant(
  { sql, env }: { sql: ReturnType<typeof getDb>; env: Deps['env'] },
  token: string,
  recipient: { email: string; auth0Sub: string },
  plan: GiftRedemptionPlan,
): Promise<void> {
  if (!plan.grantArkPlus && !plan.grantCircle) return
  try {
    const gift = await getGiftByToken(sql, token)
    if (gift?.status === 'redeemed' && gift.redeemed_by === recipient.auth0Sub) return

    const actual = await resolveEntitlementsForSub(recipient.auth0Sub, env)
    if (plan.grantCircle) {
      await syncEntitlement(env, recipient.email, actual.tier)
    }
    if (plan.grantArkPlus && !actual.entitlements.arkPlus) {
      await tryPush('downgrade (gift redeem lost the claim)', () =>
        downgradeToFree({ env, sql }, recipient.email),
      )
    }
  } catch (err) {
    console.error('[gift] could not undo the grant of a redeem that lost its claim:', err)
  }
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
// can't be read (a credit still lands; worst case it's mis-denominated).
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
// Crediting list was a money bug: gift checkout discounts the buyer (an
// auto-applied sale, or a promo code they type) and lets them pick any
// supported presentment currency, whose floors are
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
