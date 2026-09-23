import { createHmac } from 'node:crypto'
import type Stripe from 'stripe'
import { sendEmail } from '../../lib/email.js'
import { signGiftClaimToken } from '../../lib/session.js'
import { renderGiftRedemptionEmail } from '../../lib/welcome-email.js'
import { renderPaymentFailedEmail } from '../../lib/payment-failed-email.js'
import type { CancellableTier } from '../../lib/cancellation-email.js'
import { greetingFirstName } from '../../../shared/profile-name.js'
import { redactEmail } from '../../../shared/validation.js'
import { GIFT_TERM_DAYS, type GiftTerm } from '../../lib/activation.js'
import { membershipRowsForEmail } from '../../lib/entitlement-resolver.js'
import {
  deriveEntitlements,
  emailForStripeCustomer,
  liveAxes,
  liveGiftAxes,
  membershipIsLive,
  syncEntitlement,
  tierFromEntitlementString,
  tierFromEntitlements,
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
  clearMembershipSubscription,
  deleteMembershipByCustomer,
  getMembershipByStripeCustomer,
  insertGift,
  markGiftReversed,
  restoreDisputedGift,
  revokeGiftTerm,
  setMembershipStatusByCustomer,
  upsertMembership,
  voidPendingGift,
  type GiftStripeEffect,
} from '../../lib/membership.js'
import { type Plan } from '../../lib/pricing.js'
import type { Deps, Env } from '../../lib/route.js'
import {
  coerceTier,
  customerIdOf,
  periodEndIso,
  planFromSubscription,
  scheduleIdOf,
  subscriptionAmount,
  tsToIso,
} from './helpers.js'

// The tier a subscription sells, from its price product's `entitlements`
// metadata — the ONLY authority. Null means "this is not one of our membership
// subscriptions": no readable product, a deleted one, or one without the
// entitlements stamp the catalog script puts on every product we sell.
//
// Two ways this used to fail open, both gone:
//   - a product lookup that errored was swallowed and read as "no metadata". It
//     now RETHROWS: a Stripe blip is not a fact about the subscription, and the
//     webhook's 500 is what makes Stripe redeliver.
//   - "no metadata" fell back to `sub.metadata.tier`, defaulting to Ark+. That
//     metadata is stamped from the checkout request body, so it is the buyer's
//     claim about what they bought; and the default meant ANY subscription on
//     the account — a Beehiiv-native one, something made in the Dashboard —
//     provisioned a membership. The tier is never read from there now.
export async function catalogTierOfSubscription(
  sub: Stripe.Subscription,
  stripe: Stripe,
): Promise<Tier | null> {
  const productRef = sub.items?.data?.[0]?.price?.product
  if (!productRef) return null
  const product =
    typeof productRef === 'string' ? await stripe.products.retrieve(productRef) : productRef
  if ('deleted' in product && product.deleted) return null
  const derived = tierFromEntitlementString(product.metadata?.entitlements)
  return derived === 'free' ? null : derived
}

// Thrown by tierFromSubscription for a subscription that isn't ours. Its own
// class so logs tell "not a membership" from "Stripe is down" without parsing a
// message; export it when a caller needs to branch on it.
class NotAMembershipSubscriptionError extends Error {
  constructor(subscriptionId: string) {
    super(`subscription ${subscriptionId} sells no catalog entitlement`)
    this.name = 'NotAMembershipSubscriptionError'
  }
}

// catalogTierOfSubscription for callers that can only proceed with a real tier:
// same authority, but "not ours" THROWS rather than returning null, so the
// signature stays `Promise<Tier>` and nothing downstream can provision on a
// guess. Every caller already sits in a try/catch or on a path where a throw is
// the right answer (routes/auth.ts answers 502 and mints no session).
export async function tierFromSubscription(
  sub: Stripe.Subscription,
  stripe: Stripe,
): Promise<Tier> {
  const tier = await catalogTierOfSubscription(sub, stripe)
  if (!tier) throw new NotAMembershipSubscriptionError(sub.id)
  return tier
}

// The subscription as Stripe holds it NOW, or null when it no longer exists.
// Webhook payloads are snapshots and deliveries are neither ordered nor prompt: a
// retried `updated` can land after the `deleted` that ended the subscription,
// and acting on its "status: active" would re-grant a cancelled member. So the
// subscription handlers read the current state and treat the event as a nudge to
// go and look. Anything but a clean "no such subscription" rethrows — Stripe
// redelivers, which beats deciding on a snapshot we already know may be stale.
async function retrieveCurrentSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId)
  } catch (err) {
    const e = err as { code?: string; statusCode?: number } | null
    if (e?.code === 'resource_missing' || e?.statusCode === 404) return null
    throw err
  }
}

// Statuses from which a subscription never comes back.
const ENDED_SUB_STATUSES = new Set<Stripe.Subscription.Status>([
  'canceled',
  'incomplete_expired',
])

function cancelAtIso(sub: Stripe.Subscription): string | null {
  return tsToIso(sub.cancel_at)
}

// Shared props for the two subscription-shaped analytics events. Read entirely
// off the event payload — no extra Stripe calls. These are segmentation
// dimensions for a PostHog funnel, NOT a revenue figure: Stripe is the system
// of record for money (see server/lib/analytics-server.ts).
//
// `amountCents` is resolved by the caller (subscriptionAmountInOwnCurrency) so it
// is denominated in `currency`, not the USD base of a currency_options price.
function subscriptionAnalyticsProps(
  sub: Stripe.Subscription,
  tier: Tier,
  amountCents: number | null,
): { tier: string; plan: string | null; amount_cents: number | null; currency: string | null } {
  return {
    tier,
    plan: planFromSubscription(sub) ?? sub.metadata?.plan ?? null,
    amount_cents: amountCents,
    currency: sub.currency ?? null,
  }
}

// What the subscription bills, in its OWN currency. `price.unit_amount` is the
// USD base under the currency_options catalog, so reading it straight gave every
// non-USD member a dollar figure labelled with their currency. Falls back to the
// checkout-stamped metadata (written in the Session's currency) when Stripe
// can't say.
async function subscriptionAmountInOwnCurrency(
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<number | null> {
  const price = sub.items?.data?.[0]?.price
  const fromStripe = price ? await subscriptionAmount(stripe, sub, price) : null
  if (fromStripe != null) return fromStripe
  const stamped = Number(sub.metadata?.amount_cents)
  return Number.isInteger(stamped) && stamped > 0 ? stamped : null
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
  // `settled` says. Store and compare the same promise, or entries are never
  // cleared.
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
        // `deleted` is terminal, so its payload can't be stale about THIS
        // subscription. A pause can be: resumed since, the subscription is live
        // again and a late `paused` must not revoke it.
        if (event.type === 'customer.subscription.paused') {
          const current = await retrieveCurrentSubscription(stripe, sub.id)
          if (current && (current.status === 'active' || current.status === 'trialing')) {
            console.warn('[stripe] stale subscription.paused ignored (resumed since):', sub.id)
            return
          }
        }
        await handleSubscriptionEnded(sub, customerId, stripe, env)
        // No churn event here on purpose. Stripe Billing already reports churn,
        // splits voluntary from involuntary via `cancellation_details.reason`,
        // and reconciles to the ledger. See server/lib/analytics-server.ts.
      })
      break
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      if (pi.metadata?.kind === 'gift') {
        await handleGiftPurchase(
          {
            id: pi.id,
            metadata: pi.metadata,
            amount: pi.amount_received ?? pi.amount ?? null,
            currency: pi.currency ?? null,
            stamp: (metadata) => stripe.paymentIntents.update(pi.id, { metadata }),
          },
          env,
        )
      }
      break
    }
    case 'checkout.session.completed': {
      // Only the gift a promo made free. A paid gift is issued from its
      // PaymentIntent above; a $0 payment-mode Session has no PaymentIntent, so
      // without this a 100%-off gift code took the giver through checkout and
      // issued nothing. Keyed on the Session id instead, and the gift details
      // come from the Session's own metadata (routes/gift.ts stamps both).
      const session = event.data.object as Stripe.Checkout.Session
      if (
        session.mode === 'payment' &&
        session.metadata?.kind === 'gift' &&
        session.payment_status === 'no_payment_required'
      ) {
        await handleGiftPurchase(
          {
            id: session.id,
            metadata: session.metadata,
            amount: session.amount_total ?? 0,
            currency: session.currency ?? null,
            stamp: (metadata) => stripe.checkout.sessions.update(session.id, { metadata }),
          },
          env,
        )
      }
      break
    }
    case 'charge.refunded':
    case 'charge.dispute.created':
    case 'charge.dispute.funds_withdrawn': {
      // The money went back (or is being contested), so what it bought has to
      // as well. The events carry different objects — a Charge and a Dispute —
      // that happen to share the one field needed from either.
      const reversed = event.data.object as Stripe.Charge | Stripe.Dispute
      const piId =
        typeof reversed.payment_intent === 'string'
          ? reversed.payment_intent
          : reversed.payment_intent?.id ?? null
      // A dispute contests the whole charge — unless it is only an inquiry
      // (`warning_*`): no money has moved, and it closes as `warning_closed`,
      // never `won`, so a gift voided for it could never be restored. An
      // inquiry that escalates has its funds withdrawn, which lands here as
      // `charge.dispute.funds_withdrawn`. A real dispute fires both events;
      // every step below is idempotent, so the second is a no-op. A refund
      // only counts as a reversal when it is the whole charge: a partial refund
      // is a goodwill adjustment on a membership that is still paid for.
      const isDispute = event.type !== 'charge.refunded'
      const full = isDispute
        ? !(reversed as Stripe.Dispute).status?.startsWith('warning_')
        : (reversed as Stripe.Charge).refunded === true &&
          (reversed as Stripe.Charge).amount_refunded === (reversed as Stripe.Charge).amount
      if (!piId) break

      // A gift is redeemable indefinitely (no redeem-by), so without this the
      // money can be reversed while the claim link stays live forever. Void the
      // gift if it hasn't been claimed yet — on a FULL reversal only, the same
      // rule as a subscription: a partial refund is a goodwill adjustment and
      // leaves the gift good. The reason is kept so a won dispute can restore it.
      let wasGift = false
      if (env.DATABASE_URL && full) {
        const sql = getDb(env)
        const token = giftTokenForPaymentIntent(piId, env)
        const reason = isDispute ? 'dispute' : 'refund'
        wasGift = await voidPendingGift(sql, token, reason)
        if (!wasGift) {
          wasGift = await reverseRedeemedGift(token, piId, event.type, stripe, env)
        }
      }
      // Not a gift → if this charge paid a subscription invoice, the
      // subscription it paid for ends now. Cancelling is all this does: the
      // `customer.subscription.deleted` it produces runs the one revoke path.
      if (!wasGift && full) {
        await cancelSubscriptionForReversedPayment(piId, event.type, stripe)
      }
      break
    }
    case 'charge.dispute.closed': {
      // A dispute we WON on an unclaimed gift: the money is ours again, so the
      // claim link works again. Only a dispute void is restored (never a
      // refund). A gift that had already been redeemed was reversed — its term
      // taken back and any Stripe extension undone — and re-granting that is a
      // judgement call, so it is logged for a human rather than guessed at.
      const dispute = event.data.object as Stripe.Dispute
      if (dispute.status !== 'won' || !env.DATABASE_URL) break
      const piId =
        typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute.payment_intent?.id ?? null
      if (!piId) break
      const sql = getDb(env)
      const token = giftTokenForPaymentIntent(piId, env)
      if (await restoreDisputedGift(sql, token)) {
        console.warn(`[stripe] dispute won: gift for payment ${piId} restored to pending`)
        break
      }
      const rows = (await sql`
        select status from gift where redemption_token = ${token}`) as Array<{ status: string }>
      if (rows[0]?.status === 'reversed') {
        console.error(
          `[stripe] GIFT-DISPUTE-WON: payment ${piId} for a gift that was redeemed and then ` +
            'reversed by this dispute. MANUAL ACTION: the redeemer lost the gift term; re-grant it if appropriate.',
        )
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
      let failedTier: CancellableTier | null = null
      if (customerId && env.DATABASE_URL) {
        await setMembershipStatusByCustomer(getDb(env), customerId, 'past_due')
        // The membership row is also where the tier comes from for the email
        // below. Reading it here rather than off the invoice keeps this away
        // from Stripe's invoice→subscription shape, which has moved between
        // API versions; the row is ours and its `tier` is the authority anyway.
        try {
          const row = await getMembershipByStripeCustomer(getDb(env), customerId)
          const t = row?.tier
          if (t === 'ark-plus' || t === 'circle' || t === 'bundle') failedTier = t
        } catch (err) {
          console.error('[stripe] payment_failed tier read failed:', err)
        }
      }

      // Tell the member. Without this the only signal a card failed is access
      // disappearing a few weeks later, when Stripe gives up and the
      // subscription is cancelled — by which point the fix (a new card) no
      // longer helps. Best-effort: this runs after the status write, and a mail
      // failure must never 500 the webhook into a Stripe retry loop.
      if (customerId) {
        try {
          const to = await emailForStripeCustomer(invoice.customer, stripe)
          if (to) {
            const { subject, html } = renderPaymentFailedEmail({
              firstName: greetingFirstName(
                invoice.customer_name ?? undefined,
                to,
                undefined,
              ),
              tier: failedTier,
              updateCardUrl: `${env.APP_BASE_URL || 'http://localhost:5173'}/account/billing`,
            })
            // Keyed on the invoice AND the attempt: Stripe's Smart Retries fire
            // this event once per attempt over ~three weeks, and each one is a
            // fresh chance the member should hear about. Only a redelivery of
            // the SAME attempt collapses.
            const sent = await sendEmail(env, {
              to,
              subject,
              html,
              idempotencyKey: `payment_failed_${invoice.id}_${invoice.attempt_count ?? 0}`,
            })
            if (!sent) {
              console.error('[email] payment-failed email did not send:', invoice.id)
            }
          }
        } catch (err) {
          console.error('[email] payment-failed email failed:', err)
        }
      }
      // No dunning event here on purpose — Stripe's own Smart Retries reporting
      // covers failed payments and recovery rate. See lib/analytics-server.ts.
      break
    }
    default:
      break
  }
}

// A subscription is over (deleted, paused, or found gone by the upsert handler).
// Revoke what IT granted and nothing else:
//
//   1. A row that names a DIFFERENT subscription means this event is about one
//      the member has since replaced — a late `deleted` for the old sub arriving
//      after they re-subscribed. Acting on it would delete a paying member's row.
//   2. Gift terms are not the subscription's to take. A gift axis still running
//      keeps the row (cleared down to its gift half) and keeps that axis granted;
//      only the axes nothing else holds are revoked.
//   3. No row for this customer is not proof of "free": a comp, staff or gift row
//      carries no Stripe customer, so it is invisible from here. The email is
//      checked before anything is revoked BY email (Circle and Beehiiv both key
//      on it), so a stray subscription on a comped member's address can't strip
//      their access on its way out.
//
// Idempotent: a redelivery finds the row already cleared/deleted and re-mirrors
// the same remaining tier.
async function handleSubscriptionEnded(
  sub: Stripe.Subscription,
  customerId: string,
  stripe: Stripe,
  env: Env,
): Promise<void> {
  const email = await emailForStripeCustomer(sub.customer, stripe)

  if (!env.DATABASE_URL) {
    // No Neon store (preview / test envs): nothing to diff against, so mirror
    // free as before. The Beehiiv downgrade needs the DB too.
    if (email) await syncEntitlement(env, email, 'free')
    return
  }
  const sql = getDb(env)
  const row = await getMembershipByStripeCustomer(sql, customerId)

  if (row?.stripe_subscription_id && row.stripe_subscription_id !== sub.id) {
    console.warn(
      `[stripe] ended subscription ${sub.id} is not the one on the membership row (${row.stripe_subscription_id}) — stale event, ignored`,
    )
    return
  }

  let remaining = { arkPlus: false, circle: false }
  if (row) {
    remaining = liveGiftAxes(row)
  } else if (email) {
    // Throws on a failed lookup, deliberately: Stripe redelivers, which is
    // better than revoking on "couldn't check".
    const others = (await membershipRowsForEmail(env, stripe, email)).filter(membershipIsLive)
    for (const other of others) {
      const axes = liveAxes(other)
      remaining = {
        arkPlus: remaining.arkPlus || axes.arkPlus,
        circle: remaining.circle || axes.circle,
      }
    }
  }
  const remainingTier = tierFromEntitlements(remaining)

  if (email) {
    await syncEntitlement(env, email, remainingTier)
    // Beehiiv premium mirrors the arkPlus axis: drop it only when nothing else
    // still holds arkPlus. Losing the premium tier is losing the feed.
    if (!remaining.arkPlus) {
      await tryPush('downgrade (cancel)', () => downgradeToFree({ env, sql }, email))
    }
  }

  if (!row) return
  if (remainingTier === 'free') {
    // Nothing left → remove the row (absence = free).
    await deleteMembershipByCustomer(sql, customerId, sub.id)
  } else {
    await clearMembershipSubscription(sql, customerId, sub.id, remainingTier)
  }
}

// How long a failed Circle add keeps failing its event for a Stripe retry.
// Stripe itself retries for about 3 days; a day is plenty for an outage to clear.
const CIRCLE_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

// customer.subscription.created / .updated. Derives the tier from the price
// product, gates provisioning on the entitlement diff (not `statusChanged`,
// which missed tier switches — those move `items`, not `status`), writes the
// Neon membership row (the authority), and revokes any axis the prior tier
// granted that the new one doesn't — the first path that can revoke an
// entitlement without cancelling a subscription (§6).
async function handleSubscriptionUpsert(
  event: Stripe.Event,
  eventSub: Stripe.Subscription,
  customerId: string,
  stripe: Stripe,
  env: Env,
  activator: Deps['activator'],
): Promise<void> {
  const created = event.type === 'customer.subscription.created'
  const prev = (event.data.previous_attributes ?? {}) as Partial<Stripe.Subscription>

  // Act on what the subscription IS, not on what it was when this event was
  // cut (see retrieveCurrentSubscription). Gone or ended → this is a late
  // delivery for a dead subscription: run the (idempotent) ended path instead of
  // granting off the snapshot.
  const sub = await retrieveCurrentSubscription(stripe, eventSub.id)
  if (!sub || ENDED_SUB_STATUSES.has(sub.status)) {
    console.warn(`[stripe] ${event.type} for an ended subscription — treating as deleted:`, eventSub.id)
    await handleSubscriptionEnded(sub ?? eventSub, customerId, stripe, env)
    return
  }

  // Not one of ours (no catalog entitlement on its product) → not our event.
  // Checked before ANY write, the dunning status included: that update matches
  // on the customer alone, and a foreign subscription going past_due must not
  // mark a healthy membership delinquent. A failed product lookup throws from
  // here, which is the point — Stripe retries.
  const tier = await catalogTierOfSubscription(sub, stripe)
  if (!tier) {
    console.warn('[stripe] subscription sells no catalog entitlement — ignored:', sub.id)
    return
  }

  const isActive = sub.status === 'active' || sub.status === 'trialing'

  if (!isActive) {
    // Delinquent-but-not-yet-cancelled → dunning status only; no revoke here.
    // `unpaid` stops granting at read time (entitlement.ts subscriptionGrants).
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
    await activator.activateMembershipForStripeSub(sub, tier)
    const email = await emailForStripeCustomer(sub.customer, stripe)
    if (email) await syncEntitlement(env, email, tier)
    await emitProvisioningEvents(
      env,
      sub,
      tier,
      await subscriptionAmountInOwnCurrency(stripe, sub),
      email,
      created,
    )
    return
  }

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
  // The tier grants the Fold but the Circle add hasn't landed (no marker). This,
  // not the row diff, is what makes a redelivery retry a failed Circle add: the
  // row is written before the failure throws (below), so by the retry the diff
  // is gone. Gated on Circle being configured — unconfigured, activation skips
  // Circle and never stamps the marker, and every update would fan out.
  const circleOwed =
    newEnt.circle &&
    Boolean(env.CIRCLE_ADMIN_API_TOKEN && env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID) &&
    sub.metadata?.circle_provisioned !== 'true'
  const shouldFanOut = created || entitlementsChanged || notProvisioned || circleOwed

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

  let circleFailed = false
  if (shouldFanOut) {
    // Grant the (possibly new) tier — Auth0 login + the axes it grants. Provision
    // runs before the entitlement signals so an Auth0/Circle outage can't block
    // feed access. A failure propagates: Stripe retries the event rather than
    // this acking a paying member into a half-provisioned membership.
    const result = await activator.activateMembershipForStripeSub(sub, tier)
    if (result.auth0Sub) auth0Sub = result.auth0Sub
    plan = result.plan
    circleFailed = result.circleFailed

    // Axes the prior tier granted that the new one drops (a downgrade in place,
    // no cancellation) are revoked by the Beehiiv downgrade just below — losing
    // the premium tier is losing the feed.

    // Mirror the entitlement signal Neon can't reach by itself: the Circle
    // access group, per the circle axis. Auth0 holds no entitlement (task 5 is
    // done — no tier claim, no app_metadata mirror), so this writes nothing
    // there. Circle-member creation already happened in activation; this add is
    // idempotent.
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
    const amountCents = await subscriptionAmountInOwnCurrency(stripe, sub)
    await upsertMembership(getDb(env), {
      auth0_sub: auth0Sub,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      // The arkPlus grant is Beehiiv's premium tier, keyed on email, so a
      // subscription carries no provider-side id to store here.
      tier,
      status: sub.status,
      plan,
      amount_cents: amountCents,
      currency: amountCents != null ? (sub.currency ?? null) : null,
      current_period_end: periodEndIso(sub),
      cancel_at: cancelAtIso(sub),
    })
    // A pending period-end change only exists while a schedule is attached; once
    // it lands (or is released) the sub carries no schedule, so any recorded
    // pending columns are stale — clear them. Best-effort.
    if (!scheduleIdOf(sub)) {
      await clearMembershipPending(getDb(env), customerId)
    }

    // A failed Circle add is retried by failing this event — nothing else ever
    // re-attempts it (the reconciler only removes). The row is written first on
    // every path, so a Circle outage can't strand the authority on a stale tier,
    // period end or cancel_at, and a tier-drop revocation above never runs
    // against a row that still shows the old tier. The redelivery fans out again
    // via `circleOwed`; only activation's markers change, so it redoes just
    // Circle. Before analytics, so `member_provisioned` fires on the delivery
    // where the member actually got in.
    if (circleFailed) {
      // Bounded: a Circle refusal that never clears (a banned address) would
      // otherwise 500 every event for this sub. Past the window, ack and hand it
      // to a human; any later event for the sub still retries via `circleOwed`.
      const ageMs = Date.now() - event.created * 1000
      if (ageMs < CIRCLE_RETRY_WINDOW_MS) {
        throw new Error(`Circle provisioning failed for ${sub.id}; retrying`)
      }
      console.error(
        `[stripe] CIRCLE-PROVISION-FAILED ${sub.id} (customer ${customerId}): ` +
          'gave up retrying. MANUAL ACTION: add them to the Circle subscriber access group.',
      )
    }

    // Analytics last, and only after the membership row has actually committed —
    // the conversion count must never claim a member the DB doesn't have.
    //
    // Gated so a routine `subscription.updated` (a payment-method swap, our own
    // metadata stamp from activation) neither emits nor pays for the customer
    // lookup that resolving the distinct_id would cost. Tier/plan/amount changes
    // emit nothing here — expansion and contraction MRR live in Stripe.
    if (created || shouldFanOut) {
      await emitProvisioningEvents(
        env,
        sub,
        tier,
        amountCents,
        await memberEmail(),
        created,
        shouldFanOut,
      )
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
//     Beehiiv/Circle/Auth0 provisioning silently fails looks identical to a happy one
//     in every revenue dashboard; they are the ones who file support tickets.
async function emitProvisioningEvents(
  env: Env,
  sub: Stripe.Subscription,
  tier: Tier,
  amountCents: number | null,
  email: string | null,
  created: boolean,
  provisioned = true,
): Promise<void> {
  const distinctId = emailDistinctId(email)
  const attribution = attributionFromMetadata(sub.metadata)
  const props = subscriptionAnalyticsProps(sub, tier, amountCents)

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

// A subscription payment was fully refunded or disputed: end the subscription
// it paid for, now. Until this existed the money could go back while the member
// kept everything until the period ran out — or, on a dispute, indefinitely.
//
// Charge → invoice goes through the invoice-payments list: current API versions
// dropped `charge.invoice`, and an InvoicePayment is what ties a PaymentIntent to
// the invoice it settled. A payment with no subscription invoice behind it (a
// gift, a one-off) finds nothing and is left alone.
//
// Errors propagate — a reversal we failed to act on is worth Stripe's retry. An
// already-cancelled subscription is not an error: a second event for the same
// charge (dispute, then refund) finds it ended and moves on.
async function cancelSubscriptionForReversedPayment(
  paymentIntentId: string,
  eventType: string,
  stripe: Stripe,
): Promise<void> {
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    expand: ['data.invoice'],
    limit: 1,
  })
  const invoice = payments.data[0]?.invoice
  if (!invoice || typeof invoice === 'string' || ('deleted' in invoice && invoice.deleted)) {
    return
  }
  const subRef = invoice.parent?.subscription_details?.subscription
  const subscriptionId = typeof subRef === 'string' ? subRef : subRef?.id ?? null
  if (!subscriptionId) return

  const current = await retrieveCurrentSubscription(stripe, subscriptionId)
  if (!current || ENDED_SUB_STATUSES.has(current.status)) return
  console.error(
    `[stripe] PAYMENT-REVERSED ${eventType}: cancelling subscription ${subscriptionId} (payment ${paymentIntentId})`,
  )
  // Immediate, no proration credit and no final invoice: the money is already
  // back with the cardholder.
  await stripe.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false })
}

// A gift that was already REDEEMED when its payment was reversed. Take the term
// back off the redeemer's row and re-mirror what they still hold. Answers
// whether the PaymentIntent was a gift at all, so the caller doesn't go looking
// for a subscription behind a gift payment.
//
// A gift that overlapped a paid subscription also changed it inside Stripe —
// extended it (a pause / a pushed period) or credited the customer balance —
// and recorded that on the gift (gift.stripe_effect). undoGiftStripeEffect
// reverses exactly that. When it can't (no record, or the subscription has
// moved on since), the log line below says MANUAL ACTION, loud and greppable
// (GIFT-REVERSED).
async function reverseRedeemedGift(
  token: string,
  paymentIntentId: string,
  eventType: string,
  stripe: Stripe,
  env: Env,
): Promise<boolean> {
  const sql = getDb(env)
  // The atomic redeemed → reversed flip is the once-only guard: a dispute and a
  // refund on one charge are two events, and the term comes off once.
  const gift = await markGiftReversed(sql, token)
  if (!gift) {
    // Not redeemed: either no such gift (this payment wasn't one), or a gift
    // already void/reversed by an earlier event. Only the latter is "a gift".
    const rows = (await sql`
      select 1 from gift where redemption_token = ${token} limit 1`) as unknown[]
    return rows.length > 0
  }

  const covered = deriveEntitlements(gift.tier)
  const termDays = GIFT_TERM_DAYS[(gift.plan as GiftTerm) ?? '1yr'] ?? GIFT_TERM_DAYS['1yr']
  const stripeUndo = gift.stripe_effect
    ? await undoGiftStripeEffect(gift.stripe_effect, stripe)
    : 'none'
  const row = gift.redeemed_by
    ? await revokeGiftTerm(sql, gift.redeemed_by, covered, termDays)
    : null

  // Re-mirror what the redeemer still holds. The row stores no email, so it
  // comes from the Stripe customer when the row has one; a gift-only redeemer
  // has none, and the nightly reconciler (Neon-authoritative) removes the
  // external grants their row no longer backs.
  let email: string | null = null
  if (row?.stripe_customer_id) {
    try {
      email = await emailForStripeCustomer(row.stripe_customer_id, stripe)
    } catch (err) {
      console.error('[stripe] gift reversal: customer email lookup failed:', err)
    }
  }
  if (row && email) {
    const remaining = liveAxes(row)
    await syncEntitlement(env, email, tierFromEntitlements(remaining))
    if (!remaining.arkPlus) {
      const to = email
      await tryPush('downgrade (gift reversed)', () => downgradeToFree({ env, sql }, to))
    }
  }

  console.error(
    `[stripe] GIFT-REVERSED ${eventType}: payment ${paymentIntentId} for a REDEEMED ${gift.tier} gift (${gift.plan ?? 'unknown term'}) was reversed. ` +
      `Redeemer ${gift.redeemed_by ?? 'unknown'}${email ? ` <${redactEmail(email)}>` : ''}: ` +
      `${row ? `gift term (${termDays}d) taken off the membership row` : 'NO membership row found'}` +
      `${row && !email ? '; external access (Beehiiv/Circle) left to the nightly reconciler' : ''}. ` +
      (stripeUndo === 'undone'
        ? `Its Stripe change (${gift.stripe_effect?.kind}) was reversed.`
        : stripeUndo === 'none'
          ? 'No Stripe change was recorded for it. MANUAL ACTION only if it predates that record and extended a subscription or credited a balance.'
          : `MANUAL ACTION: its Stripe change (${JSON.stringify(gift.stripe_effect)}) could not be reversed automatically — undo it by hand.`),
  )
  return true
}

// Reverse what a redemption did inside Stripe (see GiftStripeEffect). Each case
// first checks the subscription still shows exactly what the gift set — if
// anything has changed it since (a later gift, a manual edit, a cancel), undoing
// blindly could clobber that, so it reports 'manual' instead.
//   trial_end → end the pushed trial at the original renewal date, or now if
//               that has already passed (they owe from then)
//   pause     → put back the earlier pause, or lift it
//   credit    → debit the balance by the amount credited
// 'undone' | 'manual' — never throws; the caller logs either way.
async function undoGiftStripeEffect(
  effect: GiftStripeEffect,
  stripe: Stripe,
): Promise<'undone' | 'manual'> {
  try {
    if (effect.kind === 'credit') {
      await stripe.customers.createBalanceTransaction(effect.customer_id, {
        amount: effect.amount, // positive = debit, cancelling the credit
        currency: effect.currency,
        description: 'Ark gift credit reversed (gift payment refunded or disputed)',
      })
      return 'undone'
    }
    const sub = await retrieveCurrentSubscription(stripe, effect.subscription_id)
    if (!sub || ENDED_SUB_STATUSES.has(sub.status)) return 'undone' // nothing left to bill
    const nowSec = Math.floor(Date.now() / 1000)
    if (effect.kind === 'trial_end') {
      if (sub.trial_end !== effect.trial_end || sub.status !== 'trialing') return 'manual'
      await stripe.subscriptions.update(sub.id, {
        trial_end: effect.previous_period_end > nowSec ? effect.previous_period_end : 'now',
        proration_behavior: 'none',
      })
      return 'undone'
    }
    if (sub.pause_collection?.resumes_at !== effect.resumes_at) return 'manual'
    await stripe.subscriptions.update(sub.id, {
      pause_collection:
        effect.previous_resumes_at != null && effect.previous_resumes_at > nowSec
          ? { behavior: 'keep_as_draft', resumes_at: effect.previous_resumes_at }
          : '',
    })
    // keep_as_draft left any invoice raised during the pause as a draft, and
    // lifting the pause doesn't finalize those. Not auto-charged on purpose:
    // billing a member for past months without asking is a support ticket.
    console.warn(
      `[stripe] gift reversal: pause lifted on ${sub.id}; draft invoices from the paused window, if any, are left for review`,
    )
    return 'undone'
  } catch (err) {
    console.error('[stripe] gift reversal: undoing the Stripe effect failed:', err)
    return 'manual'
  }
}

// The Stripe object a gift was bought through: its PaymentIntent normally, or
// its Checkout Session when a promo made it free (no PaymentIntent exists).
// Either carries the same metadata (routes/gift.ts stamps both), and `stamp`
// writes the gift_token marker back to whichever one it is.
type GiftPurchase = {
  id: string
  metadata: Stripe.Metadata | null
  amount: number | null
  currency: string | null
  stamp: (metadata: Stripe.MetadataParam) => Promise<unknown>
}

// A gift purchase grants nothing until redeemed (§3): write a pending `gift` row
// and email the recipient a claim link. Idempotent via a token derived
// deterministically from the purchase id (a retry re-derives the same token,
// and insertGift no-ops on conflict). Redemption (routes/gift.ts), not this
// webhook, writes the membership row.
async function handleGiftPurchase(purchase: GiftPurchase, env: Env): Promise<void> {
  const metadata = purchase.metadata ?? {}
  const recipientEmail = metadata.recipient_email
  const term = metadata.term
  if (!recipientEmail || (term !== '6mo' && term !== '1yr')) {
    throw new Error(`Gift purchase ${purchase.id} missing recipient_email / term`)
  }
  const token = giftTokenForPaymentIntent(purchase.id, env)

  // The purchased tier (Ark+, the Fold, or Bundle) rides in on the metadata,
  // stamped by the gift checkout route; coerce defensively. The term is stored as
  // the row's `plan` and the duration clock starts at redemption.
  const tier = coerceTier(metadata.tier)
  if (env.DATABASE_URL) {
    await insertGift(getDb(env), {
      redemption_token: token,
      tier,
      plan: term,
      amount_cents: purchase.amount,
      currency: metadata.currency ?? purchase.currency ?? null,
      giver_sub: null,
    })
  }

  // No gift-purchase event here on purpose. Stripe has the PaymentIntent and
  // Neon has the `gift` row, so purchase → redemption rate is a query over the
  // gift table (`status = 'redeemed'` / total), not something to re-derive in
  // PostHog. Only the redemption itself is instrumented (routes/gift.ts), and
  // only because the magic-link path redeems server-side with no browser event.

  // Skip the email resend once the token is stamped (a prior delivery sent it).
  if (metadata.gift_token === token) return

  // A single magic link is the whole recipient flow. We deliberately do NOT
  // provision an Auth0 account here: creating one at purchase time (with
  // email_verified:false) is what triggered Auth0's own "Verify your email"
  // message — a second, confusing email. Instead the recipient gets one branded
  // email; clicking its link (POST /api/gift/claim) creates the account,
  // pre-verified, logs them in, and redeems — see routes/gift.ts.
  const recipientName = metadata.recipient_name || undefined
  const baseUrl = env.APP_BASE_URL || 'http://localhost:5173'
  const mt = await signGiftClaimToken(
    { giftToken: token, email: recipientEmail, name: recipientName, tier },
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
    giverName: metadata.giver_name || undefined,
    term,
    message: metadata.message || undefined,
    claimUrl,
  })
  // Idempotency-keyed on the purchase so a webhook retry (or a cross-instance
  // race) re-sends at most one copy of the claim link.
  const sent = await sendEmail(env, {
    to: recipientEmail,
    subject,
    html,
    idempotencyKey: `gift_redeem_${purchase.id}`,
  })
  if (!sent) {
    // Redacted: this message lands in the webhook's error log verbatim.
    throw new Error(`gift redemption email failed to send to ${redactEmail(recipientEmail)}`)
  }
  try {
    await purchase.stamp({ ...metadata, gift_token: token })
  } catch (err) {
    console.error('[stripe] gift token stamp failed:', err)
  }
}

// A high-entropy, deterministic redemption token: HMAC(SESSION_SECRET, id), where
// id is the gift's PaymentIntent (or, for a $0 gift, its Checkout Session).
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

