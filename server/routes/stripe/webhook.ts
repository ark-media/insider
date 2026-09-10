import { createHmac } from 'node:crypto'
import type Stripe from 'stripe'
import { sendEmail } from '../../lib/email.js'
import { signGiftClaimToken } from '../../lib/session.js'
import { renderGiftRedemptionEmail } from '../../lib/welcome-email.js'
import {
  deriveEntitlements,
  emailForStripeCustomer,
  syncEntitlement,
  tierFromEntitlementString,
  type Tier,
} from '../../entitlement.js'
import {
  attributionFromMetadata,
  captureServerEvent,
  emailDistinctId,
} from '../../lib/analytics-server.js'
import { downgradeToFree, tryPush } from '../../lib/beehiiv-sync.js'
import { getDb } from '../../lib/db.js'
import {
  clearMembershipPending,
  deleteMembershipByCustomer,
  getMembershipByStripeCustomer,
  insertGift,
  setMembershipStatusByCustomer,
  upsertMembership,
} from '../../lib/membership.js'
import { type Plan } from '../../lib/pricing.js'
import type { Deps, Env } from '../../lib/route.js'
import {
  coerceTier,
  customerIdOf,
  periodEndIso,
  planFromSubscription,
  scheduleIdOf,
  tsToIso,
} from './helpers.js'

// The tier a subscription sells, from its price product's `entitlements`
// metadata (the authority) — not the client-stamped sub metadata. Falls back to
// the stamped tier only if the product metadata is missing/unreadable.
export async function tierFromSubscription(
  sub: Stripe.Subscription,
  stripe: Stripe,
): Promise<Tier> {
  const productRef = sub.items?.data?.[0]?.price?.product
  let entitlements: string | null | undefined
  try {
    if (productRef) {
      const product =
        typeof productRef === 'string' ? await stripe.products.retrieve(productRef) : productRef
      if (!('deleted' in product && product.deleted)) {
        entitlements = product.metadata?.entitlements
      }
    }
  } catch (err) {
    console.error('[stripe] tierFromSubscription product lookup failed:', err)
  }
  const derived = tierFromEntitlementString(entitlements)
  // Fall back to the checkout-stamped tier when the product metadata is missing
  // or unreadable (default Ark+).
  return derived !== 'free' ? derived : coerceTier(sub.metadata?.tier)
}

function cancelAtIso(sub: Stripe.Subscription): string | null {
  return tsToIso(sub.cancel_at)
}

// Shared props for the two subscription-shaped analytics events. Read entirely
// off the event payload — no extra Stripe calls. These are segmentation
// dimensions for a PostHog funnel, NOT a revenue figure: Stripe is the system
// of record for money (see server/lib/analytics-server.ts).
function subscriptionAnalyticsProps(
  sub: Stripe.Subscription,
  tier: Tier,
): { tier: string; plan: string | null; amount_cents: number | null; currency: string | null } {
  return {
    tier,
    plan: planFromSubscription(sub) ?? sub.metadata?.plan ?? null,
    amount_cents:
      sub.items?.data?.[0]?.price?.unit_amount ??
      (sub.metadata?.amount_cents ? Number(sub.metadata.amount_cents) : null),
    currency: sub.currency ?? null,
  }
}

// Serialize handling of same-customer deliveries within this instance so two
// concurrent webhook events for one member can't interleave their membership-row
// writes (§9 "serialize same-sub deliveries"). Cross-instance ordering is bounded
// by the event idempotency claim + last-writer-wins on updated_at.
const customerLocks = new Map<string, Promise<unknown>>()
function serializeByCustomer<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = customerLocks.get(customerId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // What the map holds is a promise nobody awaits, so it must settle rather than
  // reject: an unhandled rejection is fatal to the process in Node, and a
  // handler CAN now throw (a failed Beehiiv grant deliberately doesn't ack).
  // The caller still gets the real error, from `next`.
  //
  // The next waiter only needs to know the previous call finished, which is all
  // `settled` says. Store and compare the same promise — comparing the stored
  // value against `next` never matched, so entries were never cleared.
  const settled = next.then(
    () => {},
    () => {},
  )
  customerLocks.set(customerId, settled)
  void settled.then(() => {
    if (customerLocks.get(customerId) === settled) customerLocks.delete(customerId)
  })
  return next
}

export async function dispatchWebhookEvent(
  event: Stripe.Event,
  stripe: Stripe,
  env: Env,
  activator: Deps['activator'],
): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = customerIdOf(sub)
      await serializeByCustomer(customerId, () =>
        handleSubscriptionUpsert(event, sub, customerId, stripe, env, activator),
      )
      break
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = customerIdOf(sub)
      await serializeByCustomer(customerId, async () => {
        // Single-subscription member → no remaining entitlement. Drop the
        // entitlement signals (the Beehiiv downgrade below revokes the arkPlus
        // feed with the premium tier) and remove the membership row
        // (absence = free).
        const email = await emailForStripeCustomer(sub.customer, stripe)
        if (email) {
          await syncEntitlement(env, email, 'free')
          if (env.DATABASE_URL) {
            await tryPush('downgrade (cancel)', () =>
              downgradeToFree({ env, sql: getDb(env) }, email),
            )
          }
        }
        if (env.DATABASE_URL) {
          await deleteMembershipByCustomer(getDb(env), customerId)
        }
        // No churn event here on purpose. Stripe Billing already reports churn,
        // splits voluntary from involuntary via `cancellation_details.reason`,
        // and reconciles to the ledger. See server/lib/analytics-server.ts.
      })
      break
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      if (pi.metadata?.kind === 'gift') {
        await handleGiftPaymentIntent(pi, stripe, env)
      }
      break
    }
    case 'charge.refunded':
    case 'charge.dispute.created': {
      // A gift is redeemable indefinitely (no redeem-by), so without this the
      // money can be reversed while the claim link stays live forever. Void the
      // gift if it hasn't been claimed yet; if it already has, the grant can't
      // be walked back automatically — surface it loudly for manual handling.
      const charge = event.data.object as Stripe.Charge
      const piId =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id ?? null
      if (piId && env.DATABASE_URL) {
        const token = giftTokenForPaymentIntent(piId, env)
        const rows = await getDb(env)`
          update gift set status = 'void'
          where redemption_token = ${token} and status = 'pending'
          returning redemption_token`
        if (rows.length === 0) {
          console.error(
            `[stripe] ${event.type} did not void a pending gift (already redeemed, or not a gift):`,
            piId,
          )
        }
      }
      break
    }
    case 'invoice.payment_failed': {
      // Dunning: reflect the delinquency on the membership row (task 9). Keep
      // entitlement — Stripe's dunning retries within the grace window; a later
      // subscription.deleted revokes if it ultimately fails.
      const invoice = event.data.object as Stripe.Invoice
      console.warn('[stripe] invoice.payment_failed', invoice.id)
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
      if (customerId && env.DATABASE_URL) {
        await setMembershipStatusByCustomer(getDb(env), customerId, 'past_due')
      }
      // No dunning event here on purpose — Stripe's own Smart Retries reporting
      // covers failed payments and recovery rate. See lib/analytics-server.ts.
      break
    }
    default:
      break
  }
}

// customer.subscription.created / .updated. Derives the tier from the price
// product, gates provisioning on the entitlement diff (not `statusChanged`,
// which missed tier switches — those move `items`, not `status`), writes the
// Neon membership row (the authority), and revokes any axis the prior tier
// granted that the new one doesn't — the first path that can revoke an
// entitlement without cancelling a subscription (§6).
async function handleSubscriptionUpsert(
  event: Stripe.Event,
  sub: Stripe.Subscription,
  customerId: string,
  stripe: Stripe,
  env: Env,
  activator: Deps['activator'],
): Promise<void> {
  const created = event.type === 'customer.subscription.created'
  const prev = (event.data.previous_attributes ?? {}) as Partial<Stripe.Subscription>
  const isActive = sub.status === 'active' || sub.status === 'trialing'

  if (!isActive) {
    // Delinquent-but-not-yet-cancelled → dunning status only; no revoke.
    if (env.DATABASE_URL && (sub.status === 'past_due' || sub.status === 'unpaid')) {
      await setMembershipStatusByCustomer(getDb(env), customerId, sub.status)
    }
    return
  }

  // Without the Neon store (preview / test envs) there is no membership row to
  // diff or write, so keep the pre-task-9 behavior: provision + mirror the
  // entitlement signals only on a status change. The diff-gated row logic below
  // is the production path.
  if (!env.DATABASE_URL) {
    const statusChanged = created || 'status' in prev
    if (!statusChanged) return
    const noDbTier = await tierFromSubscription(sub, stripe)
    await activator.activateMembershipForStripeSub(sub, noDbTier)
    const email = await emailForStripeCustomer(sub.customer, stripe)
    if (email) await syncEntitlement(env, email, noDbTier)
    await emitProvisioningEvents(env, sub, noDbTier, email, created)
    return
  }

  const tier = await tierFromSubscription(sub, stripe)
  const newEnt = deriveEntitlements(tier)

  // priorTier from the existing row BEFORE any write (default free), keyed on the
  // customer so it doesn't depend on provisioning having run (§3 ordering trap).
  const priorRow = env.DATABASE_URL
    ? await getMembershipByStripeCustomer(getDb(env), customerId)
    : null
  const priorTier: Tier = (priorRow?.tier as Tier | undefined) ?? 'free'
  const priorEnt = deriveEntitlements(priorTier)
  const entitlementsChanged =
    newEnt.arkPlus !== priorEnt.arkPlus || newEnt.circle !== priorEnt.circle

  // Not-yet-provisioned = no axis marker on the sub. Combined with created / a
  // real entitlement diff, this is the fan-out gate.
  const notProvisioned =
    sub.metadata?.beehiiv_premium !== 'true' &&
    sub.metadata?.circle_provisioned !== 'true' &&
    !sub.metadata?.auth0_user_id
  const shouldFanOut = created || entitlementsChanged || notProvisioned

  // Fall back to the prior row's sub when the event carries no auth0_user_id
  // marker (an externally-triggered subscription.updated that skips the fan-out):
  // the row we're about to write is keyed on auth0_sub, and re-using the known
  // one avoids throwing — which would 500 the webhook and trap the event in an
  // infinite Stripe retry loop.
  let auth0Sub = sub.metadata?.auth0_user_id ?? priorRow?.auth0_sub ?? null
  let plan = planFromSubscription(sub) ?? (sub.metadata?.plan as Plan | undefined) ?? 'yearly'

  // The customer's email backs the analytics distinct_id, and the fan-out below
  // already needs it. Resolve at most once per event — a PWYC-only change skips
  // the fan-out entirely but still emits `subscription_tier_changed`, so the
  // lookup can't live inside that branch.
  let resolvedEmail: string | null | undefined
  const memberEmail = async (): Promise<string | null> => {
    if (resolvedEmail === undefined) {
      resolvedEmail = await emailForStripeCustomer(sub.customer, stripe)
    }
    return resolvedEmail
  }

  if (shouldFanOut) {
    // Grant the (possibly new) tier — Auth0 login + the axes it grants. Provision
    // runs before the entitlement signals so an Auth0/Circle outage can't block
    // feed access. A failure propagates: Stripe retries the event rather than
    // this acking a paying member into a half-provisioned membership.
    const result = await activator.activateMembershipForStripeSub(sub, tier)
    if (result.auth0Sub) auth0Sub = result.auth0Sub
    plan = result.plan

    // Axes the prior tier granted that the new one drops (a downgrade in place,
    // no cancellation) are revoked by the Beehiiv downgrade just below — losing
    // the premium tier is losing the feed.

    // Mirror the entitlement signals: Auth0 tier claim (transitional shim, task 5
    // pending) + the Circle access group per the circle axis. Circle-member
    // creation already happened in activation; this add is idempotent.
    const email = await memberEmail()
    if (email) {
      await syncEntitlement(env, email, tier)
      // Beehiiv premium mirrors the arkPlus axis: drop it when arkPlus is lost.
      if (priorEnt.arkPlus && !newEnt.arkPlus && env.DATABASE_URL) {
        await tryPush('downgrade (tier drop)', () =>
          downgradeToFree({ env, sql: getDb(env) }, email),
        )
      }
    }
  }

  // Write the membership row (the authority) keyed on auth0_sub. Without a
  // resolved sub we can't key it — throw so Stripe retries rather than leave a
  // paying member reading free (§8 risk 2). No DB → nothing to persist.
  if (env.DATABASE_URL) {
    if (!auth0Sub) {
      throw new Error(`membership row: no auth0_sub resolved for customer ${customerId}`)
    }
    const amountCents =
      sub.items.data[0]?.price?.unit_amount ??
      (sub.metadata?.amount_cents ? Number(sub.metadata.amount_cents) : null)
    await upsertMembership(getDb(env), {
      auth0_sub: auth0Sub,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      // No SC id comes off a subscription any more — the arkPlus grant is the
      // Beehiiv premium tier, keyed on email. Gift redemption still writes one,
      // and the upsert coalesces, so passing null here preserves it.
      tier,
      status: sub.status,
      plan,
      amount_cents: amountCents,
      current_period_end: periodEndIso(sub),
      cancel_at: cancelAtIso(sub),
    })
    // A pending period-end change only exists while a schedule is attached; once
    // it lands (or is released) the sub carries no schedule, so any recorded
    // pending columns are stale — clear them. Best-effort.
    if (!scheduleIdOf(sub)) {
      await clearMembershipPending(getDb(env), customerId)
    }

    // Analytics last, and only after the membership row has actually committed —
    // the conversion count must never claim a member the DB doesn't have.
    //
    // Gated so a routine `subscription.updated` (a payment-method swap, our own
    // metadata stamp from activation) neither emits nor pays for the customer
    // lookup that resolving the distinct_id would cost. Tier/plan/amount changes
    // emit nothing here — expansion and contraction MRR live in Stripe.
    if (created || shouldFanOut) {
      await emitProvisioningEvents(env, sub, tier, await memberEmail(), created, shouldFanOut)
    }
  }
}

// The two subscription-side server events that survive the "is this already in
// Stripe?" test:
//
//   subscription_started_confirmed — the honest numerator for a conversion rate
//     whose denominator (pricing_viewed, checkout_opened) only exists in the
//     browser. Browser `checkout_succeeded` is undercounted by ad blockers and
//     inflated by double-submits, so it can't play that role itself. This is not
//     a revenue count — Stripe is.
//   member_provisioned — "paid" vs "actually got access". A member whose
//     SC/Circle/Auth0 provisioning silently fails looks identical to a happy one
//     in every revenue dashboard; they are the ones who file support tickets.
async function emitProvisioningEvents(
  env: Env,
  sub: Stripe.Subscription,
  tier: Tier,
  email: string | null,
  created: boolean,
  provisioned = true,
): Promise<void> {
  const distinctId = emailDistinctId(email)
  const attribution = attributionFromMetadata(sub.metadata)
  const props = subscriptionAnalyticsProps(sub, tier)

  if (created) {
    await captureServerEvent(env, {
      event: 'subscription_started_confirmed',
      distinctId,
      properties: props,
      attribution,
    })
  }
  if (provisioned) {
    const ent = deriveEntitlements(tier)
    const axes = [ent.arkPlus ? 'ark-plus' : null, ent.circle ? 'circle' : null]
      .filter(Boolean)
      .join('+')
    await captureServerEvent(env, {
      event: 'member_provisioned',
      distinctId,
      properties: { ...props, axes: axes || 'none' },
      attribution,
    })
  }
}

// A gift PaymentIntent grants nothing until redeemed (§3): write a pending
// `gift` row and email the recipient a claim link. Idempotent via a token
// derived deterministically from the PI id (a retry re-derives the same token,
// and insertGift no-ops on conflict). Redemption (routes/gift.ts), not this
// webhook, writes the membership row.
async function handleGiftPaymentIntent(
  pi: Stripe.PaymentIntent,
  stripe: Stripe,
  env: Env,
): Promise<void> {
  const recipientEmail = pi.metadata?.recipient_email
  const term = pi.metadata?.term
  if (!recipientEmail || (term !== '6mo' && term !== '1yr')) {
    throw new Error('Gift PaymentIntent missing recipient_email / term')
  }
  const token = giftTokenForPaymentIntent(pi.id, env)

  // The purchased tier (Ark+, the Fold, or Bundle) rides in on PI metadata,
  // stamped by the gift checkout route; coerce defensively. The term is stored as
  // the row's `plan` and the duration clock starts at redemption.
  const tier = coerceTier(pi.metadata?.tier)
  if (env.DATABASE_URL) {
    await insertGift(getDb(env), {
      redemption_token: token,
      tier,
      plan: term,
      amount_cents: pi.amount_received ?? pi.amount ?? null,
      currency: pi.metadata?.currency ?? pi.currency ?? null,
      giver_sub: null,
    })
  }

  // No gift-purchase event here on purpose. Stripe has the PaymentIntent and
  // Neon has the `gift` row, so purchase → redemption rate is a query over the
  // gift table (`status = 'redeemed'` / total), not something to re-derive in
  // PostHog. Only the redemption itself is instrumented (routes/gift.ts), and
  // only because the magic-link path redeems server-side with no browser event.

  // Skip the email resend once the token is stamped (a prior delivery sent it).
  if (pi.metadata?.gift_token === token) return

  // A single magic link is the whole recipient flow. We deliberately do NOT
  // provision an Auth0 account here: creating one at purchase time (with
  // email_verified:false) is what triggered Auth0's own "Verify your email"
  // message — a second, confusing email. Instead the recipient gets one branded
  // email; clicking its link (POST /api/gift/claim) creates the account,
  // pre-verified, logs them in, and redeems — see routes/gift.ts.
  const recipientName = pi.metadata?.recipient_name || undefined
  const baseUrl = env.APP_BASE_URL || 'http://localhost:5173'
  const mt = await signGiftClaimToken(
    { giftToken: token, email: recipientEmail, name: recipientName },
    env,
  )
  const claimUrl = `${baseUrl}/redeem?mt=${encodeURIComponent(mt)}`

  // Send the claim email BEFORE stamping the idempotency marker: stamping first
  // meant a transient send failure lost the only claim link forever (the retry
  // early-returned on the now-set marker). Throw on failure so Stripe retries the
  // webhook and re-sends; a rare duplicate email is strictly better than a gift
  // the recipient can never claim. The marker is stamped only after success.
  const { subject, html } = renderGiftRedemptionEmail({
    recipientName,
    recipientEmail,
    giverName: pi.metadata?.giver_name || undefined,
    term,
    message: pi.metadata?.message || undefined,
    claimUrl,
  })
  // Idempotency-keyed on the PI so a webhook retry (or a cross-instance race)
  // re-sends at most one copy of the claim link.
  const sent = await sendEmail(env, {
    to: recipientEmail,
    subject,
    html,
    idempotencyKey: `gift_redeem_${pi.id}`,
  })
  if (!sent) {
    throw new Error(`gift redemption email failed to send to ${recipientEmail}`)
  }
  try {
    await stripe.paymentIntents.update(pi.id, {
      metadata: { ...pi.metadata, gift_token: token },
    })
  } catch (err) {
    console.error('[stripe] gift token stamp failed:', err)
  }
}

// A high-entropy, deterministic redemption token: HMAC(SESSION_SECRET, pi.id).
// Deterministic so webhook retries re-derive the same token (idempotent gift
// row); unguessable so the link can't be brute-forced from a PI id.
export function giftTokenForPaymentIntent(piId: string, env: Env): string {
  const secret = env.SESSION_SECRET || env.CHECKOUT_SESSION_SECRET
  // Never default this. The token is the ONLY authorization on /api/gift/redeem,
  // so a hardcoded fallback key ('gift') would make it a pure function of a
  // PaymentIntent id — a value the buyer sees and that appears in Stripe
  // tooling. Match the 32-byte floor the other first-party tokens enforce, and
  // fail loudly rather than minting forgeable instruments in a misconfigured env.
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET (>= 32 bytes) required to derive gift tokens')
  }
  return createHmac('sha256', secret).update(`gift:${piId}`).digest('base64url')
}

