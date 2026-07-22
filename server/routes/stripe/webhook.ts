import { createHmac } from 'node:crypto'
import type Stripe from 'stripe'
import { AlreadySubscribedError } from '../../lib/activation.js'
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
import { createScClient } from '../../lib/sc-client.js'
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

// Serialize handling of same-customer deliveries within this instance so two
// concurrent webhook events for one member can't interleave their membership-row
// writes (§9 "serialize same-sub deliveries"). Cross-instance ordering is bounded
// by the event idempotency claim + last-writer-wins on updated_at.
const customerLocks = new Map<string, Promise<unknown>>()
function serializeByCustomer<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = customerLocks.get(customerId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  customerLocks.set(
    customerId,
    next.finally(() => {
      if (customerLocks.get(customerId) === next) customerLocks.delete(customerId)
    }),
  )
  return next
}

// Delete the SC subscription recorded on the sub metadata (revokes the arkPlus
// feed). Soft-fail: a transient SC error must not 500 the webhook.
async function revokeScFeed(sub: Stripe.Subscription, env: Env): Promise<void> {
  const scSubId = sub.metadata?.sc_subscription_id
  if (!scSubId) return
  try {
    await createScClient(env).call('DELETE', `/subscriptions/${scSubId}`)
  } catch (err) {
    console.error('[dev-api] SC revoke failed:', err)
  }
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
        // Single-subscription member → no remaining entitlement. Revoke SC, drop
        // the entitlement signals, and remove the membership row (absence = free).
        await revokeScFeed(sub, env)
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

  // Mirror Stripe's scheduled-cancel state onto SC so feed access self-expires
  // even if the later .deleted webhook is missed. Bidirectional.
  await syncScCancelSchedule(sub, prev, env)

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
    !sub.metadata?.sc_subscription_id &&
    sub.metadata?.circle_provisioned !== 'true' &&
    !sub.metadata?.auth0_user_id
  const shouldFanOut = created || entitlementsChanged || notProvisioned

  // Fall back to the prior row's sub when the event carries no auth0_user_id
  // marker (an externally-triggered subscription.updated that skips the fan-out):
  // the row we're about to write is keyed on auth0_sub, and re-using the known
  // one avoids throwing — which would 500 the webhook and trap the event in an
  // infinite Stripe retry loop.
  let auth0Sub = sub.metadata?.auth0_user_id ?? priorRow?.auth0_sub ?? null
  let scUserId = sub.metadata?.sc_user_id
    ? Number(sub.metadata.sc_user_id)
    : priorRow?.sc_user_id ?? null
  let plan = planFromSubscription(sub) ?? (sub.metadata?.plan as Plan | undefined) ?? 'yearly'

  if (shouldFanOut) {
    // Grant the (possibly new) tier — Auth0 login + the axes it grants. Provision
    // runs before the entitlement signals so an Auth0/Circle outage can't block
    // feed access; the ids come back for the row.
    try {
      const result = await activator.activateMembershipForStripeSub(sub, tier)
      if (result.auth0Sub) auth0Sub = result.auth0Sub
      if (result.scUserId != null) scUserId = result.scUserId
      plan = result.plan
    } catch (err) {
      if (!(err instanceof AlreadySubscribedError)) throw err
      // The SC subscription create lost a race to the /api/auth/checkout-session
      // poll — the client runs it right after checkout and it provisions the SAME
      // Stripe sub concurrently, so one path's POST /subscriptions 409s. This is
      // NOT the terminal "buyer already has a prior membership" conflict routes.ts
      // guards against: re-read the sub to adopt the ids the sibling stamped and
      // fall through to write the membership row (the authority) rather than
      // acking 200 with no row. If the sibling hasn't stamped auth0_user_id yet,
      // auth0Sub stays unresolved and the row-write below throws a plain Error →
      // Stripe retries → the redelivery finds it stamped.
      console.warn(
        `[stripe] subscription.created raced checkout-poll for ${customerId}; adopting stamped ids`,
      )
      const fresh = await stripe.subscriptions.retrieve(sub.id)
      if (fresh.metadata?.auth0_user_id) auth0Sub = fresh.metadata.auth0_user_id
      if (fresh.metadata?.sc_user_id) scUserId = Number(fresh.metadata.sc_user_id)
    }

    // Revoke axes the prior tier granted that the new one drops (a downgrade in
    // place, no cancellation).
    if (priorEnt.arkPlus && !newEnt.arkPlus) await revokeScFeed(sub, env)

    // Mirror the entitlement signals: Auth0 tier claim (transitional shim, task 5
    // pending) + the Circle access group per the circle axis. Circle-member
    // creation already happened in activation; this add is idempotent.
    const email = await emailForStripeCustomer(sub.customer, stripe)
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
      sc_user_id: scUserId,
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

  // Current gift product is Ark+; the term is stored as the row's `plan` and the
  // duration clock starts at redemption.
  if (env.DATABASE_URL) {
    await insertGift(getDb(env), {
      redemption_token: token,
      tier: 'ark-plus',
      plan: term,
      amount_cents: pi.amount_received ?? pi.amount ?? null,
      giver_sub: null,
    })
  }

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
  const secret = env.SESSION_SECRET || env.CHECKOUT_SESSION_SECRET || 'gift'
  return createHmac('sha256', secret).update(`gift:${piId}`).digest('base64url')
}

// Push Stripe's scheduled-cancel state onto the SC subscription. Only acts when
// the cancel schedule actually changed in this event (cancel_at /
// cancel_at_period_end present in previous_attributes), so routine updates —
// payment-method swaps, our own metadata stamp from activation — don't generate
// spurious SC writes.
//
//   scheduled to cancel → ends_at = cancel_at, autorenew = false  (SC shows
//     "Expiring"; the member keeps access until ends_at, then SC expires them)
//   un-canceled         → ends_at = null,       autorenew = true
//
// `status` is left for SC to derive. Soft-fail like the DELETE path: a transient
// SC error must not 500 the webhook (which would make Stripe retry the event).
async function syncScCancelSchedule(
  sub: Stripe.Subscription,
  prev: Partial<Stripe.Subscription>,
  env: Env,
): Promise<void> {
  // Named for what we actually check — fields present in `previous_attributes`
  // — not "the schedule semantically changed," which Stripe doesn't tell us.
  const cancelFieldsPresent =
    'cancel_at' in prev || 'cancel_at_period_end' in prev
  if (!cancelFieldsPresent) return
  const scSubId = sub.metadata?.sc_subscription_id
  if (!scSubId) return
  // Guard against a malformed payload pushing "Invalid Date" to SC, where it
  // would silently 422 into the catch and produce an unhelpful log line.
  const endsAt = tsToIso(sub.cancel_at)
  const body = endsAt
    ? { ends_at: endsAt, autorenew: false }
    : { ends_at: null, autorenew: true }
  try {
    await createScClient(env).call('PATCH', `/subscriptions/${scSubId}`, body)
  } catch (err) {
    console.error('[dev-api] SC cancel-schedule sync failed:', err)
  }
}
