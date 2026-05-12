// SC subscription / gift activation.
//
// Two callers can race for the same Stripe sub: the webhook (eventually
// consistent) and /api/auth/checkout-session (called by the SPA right after
// confirmPayment). Three layers of dedup keep a duplicate SC subscription
// from being created:
//
//   1. Per-instance: `provisionInFlight` — the second caller in the same
//      process awaits the first's promise and re-reads Stripe metadata.
//   2. Cross-instance metadata re-check: we re-read Stripe between SC user
//      resolution and SC subscription POST, in case another instance won
//      while we were mid-flight.
//   3. SC-side idempotency: an `Idempotency-Key` derived from the Stripe sub
//      / payment-intent id is sent on POST /subscriptions, so an SC API
//      that honors the header will return the existing record on a retry.

import type Stripe from 'stripe'
import { syncEntitlement } from '../entitlement.js'
import { findOrCreateAuth0User } from './auth0-user.js'
import {
  createScClient,
  findOrCreateScUser,
  findScUserByEmail,
  type ScUser,
} from './sc-client.js'

type Env = Record<string, string>

// Gift purchases — one-time Stripe charge, fixed-term SC subscription
// stamped with ends_at. Term + price live here so the activator owns the
// gift policy in one place.
export type GiftTerm = '6mo' | '1yr'

export type GiftMetadata = {
  giverEmail: string
  giverName?: string
  orderId: string // Stripe PaymentIntent id
  term: GiftTerm
  purchasedAt: string // ISO date
  message?: string
}

export const GIFT_PRICES_CENTS: Record<GiftTerm, number> = {
  '6mo': 4800,
  '1yr': 8000,
}
export const GIFT_TERM_DAYS: Record<GiftTerm, number> = {
  '6mo': 182,
  '1yr': 365,
}

export type Activator = {
  activateScSubscriptionForStripeSub: (sub: Stripe.Subscription) => Promise<void>
  activateScGiftForPaymentIntent: (pi: Stripe.PaymentIntent) => Promise<void>
}

export function createActivator(env: Env, stripe: Stripe | null): Activator {
  const resolveScPriceId = (plan: 'monthly' | 'yearly'): string => {
    const id =
      plan === 'monthly'
        ? env.SC_SUBSCRIPTION_PRICE_ID_MONTHLY
        : env.SC_SUBSCRIPTION_PRICE_ID_YEARLY
    if (!id) {
      throw new Error(
        `SC_SUBSCRIPTION_PRICE_ID_${plan.toUpperCase()} must be set in .env`,
      )
    }
    return id
  }

  const resolveScGiftPriceId = (term: GiftTerm): string => {
    const id =
      term === '6mo'
        ? env.SC_SUBSCRIPTION_PRICE_ID_GIFT_6MO
        : env.SC_SUBSCRIPTION_PRICE_ID_GIFT_1YR
    const envKey =
      term === '6mo'
        ? 'SC_SUBSCRIPTION_PRICE_ID_GIFT_6MO'
        : 'SC_SUBSCRIPTION_PRICE_ID_GIFT_1YR'
    if (!id) throw new Error(`${envKey} must be set in .env`)
    return id
  }

  const provisionInFlight = new Map<string, Promise<void>>()

  const doActivate = async (subId: string): Promise<void> => {
    if (!stripe) return

    // Re-read inside the critical section. The caller's in-memory `sub`
    // snapshot may be stale: another caller could have finished provisioning
    // (and written metadata) between their retrieve and our handler firing.
    const fresh = await stripe.subscriptions.retrieve(subId)
    if (fresh.metadata?.sc_subscription_id) return

    const customerId =
      typeof fresh.customer === 'string' ? fresh.customer : fresh.customer.id
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted) throw new Error('Stripe customer was deleted')
    const activeCustomer = customer as Stripe.Customer
    const email = activeCustomer.email
    if (!email) throw new Error('Stripe customer has no email')

    const plan =
      (fresh.metadata?.plan as 'monthly' | 'yearly' | undefined) ?? 'yearly'

    const scPriceId = resolveScPriceId(plan)

    const sc = createScClient(env)
    const user = await findOrCreateScUser(sc, email, activeCustomer.name ?? undefined)

    // Cross-instance race window: between the initial metadata read and
    // here, the SC user lookup added several hundred ms of network time —
    // long enough for another instance (the webhook running concurrently
    // with /api/auth/checkout-session) to have finished. Re-check before
    // creating a fresh SC subscription.
    const recheck = await stripe.subscriptions.retrieve(subId)
    if (recheck.metadata?.sc_subscription_id) return

    const created = await sc.call<{ subscription: { id: number } }>(
      'POST',
      '/subscriptions',
      { user_id: user.id, subscription_price_id: Number(scPriceId) },
      { idempotencyKey: `stripe_sub_${subId}` },
    )

    let auth0Result: Awaited<ReturnType<typeof findOrCreateAuth0User>> = null
    try {
      auth0Result = await findOrCreateAuth0User(email, activeCustomer.name ?? undefined, env)
    } catch (err) {
      console.error('[auth0] findOrCreateAuth0User failed:', err)
    }
    if (auth0Result?.created && !auth0Result.passwordResetSent) {
      console.error(
        '[auth0] new user created but password-reset email did not send:',
        email,
      )
    }
    const auth0UserId = auth0Result?.userId ?? null

    await stripe.subscriptions.update(fresh.id, {
      metadata: {
        ...fresh.metadata,
        sc_user_id: String(user.id),
        sc_subscription_id: String(created.subscription.id),
        ...(auth0UserId ? { auth0_user_id: auth0UserId } : {}),
      },
    })
  }

  const activateScSubscriptionForStripeSub = async (
    sub: Stripe.Subscription,
  ): Promise<void> => {
    if (!stripe) return
    if (sub.metadata?.sc_subscription_id) return // already granted, fast path

    const existing = provisionInFlight.get(sub.id)
    if (existing) return existing

    const promise = doActivate(sub.id).finally(() => {
      provisionInFlight.delete(sub.id)
    })
    provisionInFlight.set(sub.id, promise)
    return promise
  }

  const activateScGiftForPaymentIntent = async (
    pi: Stripe.PaymentIntent,
  ): Promise<void> => {
    if (!stripe) return
    if (pi.metadata?.sc_subscription_id) return // already granted (idempotent)

    const term = pi.metadata?.term as GiftTerm | undefined
    const recipientEmail = pi.metadata?.recipient_email
    const giverEmail = pi.metadata?.giver_email
    if (!term || !recipientEmail || !giverEmail) {
      throw new Error('Gift PaymentIntent missing required metadata')
    }
    if (term !== '6mo' && term !== '1yr') {
      throw new Error(`Unknown gift term: ${term}`)
    }

    const recipientName = pi.metadata?.recipient_name || undefined
    const giverName = pi.metadata?.giver_name || undefined
    const message = pi.metadata?.message || undefined

    const gift: GiftMetadata = {
      giverEmail,
      giverName,
      orderId: pi.id,
      term,
      purchasedAt: new Date().toISOString(),
      message,
    }

    const sc = createScClient(env)
    const scPriceId = resolveScGiftPriceId(term)

    // Find-or-create the recipient SC user, stamping gift metadata on their
    // record via the SC API's custom_1 / custom_2 fields.
    let recipient = await findScUserByEmail(sc, recipientEmail)
    if (recipient) {
      await sc.call('PATCH', `/users/${recipient.id}`, {
        custom_1: 'gift',
        custom_2: JSON.stringify(gift),
      })
    } else {
      const first = (recipientName || recipientEmail.split('@')[0] || 'Member').slice(0, 40)
      const created = await sc.call<{ user: ScUser }>('POST', '/users', {
        email: recipientEmail,
        first_name: first,
        last_name: '',
        custom_1: 'gift',
        custom_2: JSON.stringify(gift),
      })
      recipient = created.user
    }

    // Cross-instance race re-check (see doActivate above).
    const piRecheck = await stripe.paymentIntents.retrieve(pi.id)
    if (piRecheck.metadata?.sc_subscription_id) return

    const endsAt = new Date(
      Date.now() + GIFT_TERM_DAYS[term] * 24 * 60 * 60 * 1000,
    ).toISOString()

    const createdSub = await sc.call<{ subscription: { id: number } }>(
      'POST',
      '/subscriptions',
      {
        user_id: recipient.id,
        subscription_price_id: Number(scPriceId),
        ends_at: endsAt,
      },
      { idempotencyKey: `stripe_pi_${pi.id}` },
    )

    let auth0Result: Awaited<ReturnType<typeof findOrCreateAuth0User>> = null
    try {
      auth0Result = await findOrCreateAuth0User(recipientEmail, recipientName, env)
    } catch (err) {
      console.error('[auth0] findOrCreateAuth0User (gift) failed:', err)
    }
    if (auth0Result?.created && !auth0Result.passwordResetSent) {
      console.error(
        '[auth0] gift recipient created but password-reset email did not send:',
        recipientEmail,
      )
    }
    const auth0UserId = auth0Result?.userId ?? null

    await stripe.paymentIntents.update(pi.id, {
      metadata: {
        ...pi.metadata,
        sc_user_id: String(recipient.id),
        sc_subscription_id: String(createdSub.subscription.id),
        ...(auth0UserId ? { auth0_user_id: auth0UserId } : {}),
      },
    })

    // Welcome email to the recipient. Soft-fail: the gift is already granted.
    try {
      await sc.call('POST', `/users/${recipient.id}/send_welcome_email`, {})
    } catch (err) {
      console.error('[dev-api] gift send_welcome_email failed:', err)
    }

    // Grant subscriber entitlement for the duration of the gift.
    // gift_expires_at is stamped on Auth0 app_metadata so the reconciler's
    // downgrade pass honors the gift even though there is no recurring
    // Stripe sub.
    await syncEntitlement(env, recipientEmail, 'subscriber', { giftExpiresAt: endsAt })
  }

  return { activateScSubscriptionForStripeSub, activateScGiftForPaymentIntent }
}
