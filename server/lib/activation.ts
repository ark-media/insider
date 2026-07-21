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
import {
  deriveEntitlements,
  provisionCircleMember,
  syncEntitlement,
  type Tier,
} from '../entitlement.js'
import {
  createAuth0PasswordChangeTicket,
  findOrCreateAuth0User,
} from './auth0-user.js'
import { ensureSubscribedWithPremium, tryPush } from './beehiiv-sync.js'
import { getDb } from './db.js'
import { sendEmail } from './email.js'
import {
  renderCircleWelcomeEmail,
  renderGiftWelcomeEmail,
  renderSubscriberWelcomeEmail,
} from './welcome-email.js'
import {
  createScClient,
  findOrCreateScUser,
  findScUserByEmail,
  type ScUser,
} from './sc-client.js'

type Env = Record<string, string>
type Plan = 'monthly' | 'yearly'

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

// What a paid-tier activation resolved to. The webhook (task 9) reads this to
// write the Neon membership row: `auth0Sub` keys it, `scUserId` is the arkPlus
// join key, `plan`/`tier` describe the SKU. Any field is null when its axis
// wasn't granted or its provisioning soft-failed (Auth0 down, no SC feed for a
// Circle-only tier) — the caller must not write a row without an `auth0Sub`.
export type MembershipProvisionResult = {
  email: string
  name?: string
  tier: Tier
  plan: Plan
  auth0Sub: string | null
  scUserId: number | null
  scSubscriptionId: number | null
}

export type Activator = {
  // Tier-aware provisioning: Auth0 login for every paid tier, SC only when the
  // tier grants arkPlus, Circle only when it grants circle. Returns the ids the
  // webhook needs for the membership row. Idempotent per axis (keyed on sub
  // metadata markers).
  activateMembershipForStripeSub: (
    sub: Stripe.Subscription,
    tier: Tier,
  ) => Promise<MembershipProvisionResult>
  // Back-compat shim for callers not yet tier-aware (the post-checkout auth
  // route): provisions the Ark+ tier. Task 9 moves the webhook onto the
  // tier-aware method above.
  activateScSubscriptionForStripeSub: (sub: Stripe.Subscription) => Promise<void>
  activateScGiftForPaymentIntent: (pi: Stripe.PaymentIntent) => Promise<void>
  // Grant a redeemed gift to the signed-in recipient (routes/gift.ts). SC only
  // for arkPlus tiers, Circle only for circle; the entitlement runs for the gift
  // term from redemption. Returns the SC ids + the computed expiry for the
  // membership row.
  activateGiftForRecipient: (opts: {
    email: string
    name?: string
    tier: Tier
    term: GiftTerm
    auth0Sub: string | null
  }) => Promise<{ scUserId: number | null; scSubscriptionId: number | null; endsAt: string }>
}

// SC rejects a second active subscription per user with HTTP 409. We translate
// that to this typed error so callers (the post-checkout route + the webhook)
// can react differently from a generic provisioning failure.
export class AlreadySubscribedError extends Error {
  readonly kind = 'already_subscribed' as const
  readonly email: string
  constructor(email: string) {
    super(`User ${email} already has an active subscription on this network.`)
    this.name = 'AlreadySubscribedError'
    this.email = email
  }
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

  const provisionInFlight = new Map<string, Promise<MembershipProvisionResult>>()

  // Create the Auth0 login for a paid member (any tier), suppressing Auth0's own
  // reset email — the single welcome email carries the set-password link. Soft-
  // fails to a null userId so an Auth0 outage can't block the paid product; the
  // webhook then can't write a membership row and retries. Runs for every paid
  // tier, not just SC — a Circle-only buyer needs a login to SSO into what they
  // bought (§8 risk 6).
  const ensureAuth0Login = async (
    email: string,
    name: string | undefined,
    baseUrl: string,
  ): Promise<{ userId: string | null; created: boolean; passwordSetupUrl?: string }> => {
    let auth0Result: Awaited<ReturnType<typeof findOrCreateAuth0User>> = null
    try {
      auth0Result = await findOrCreateAuth0User(email, name, env, {
        emailPasswordReset: false,
      })
    } catch (err) {
      console.error('[auth0] findOrCreateAuth0User failed:', err)
    }
    const userId = auth0Result?.userId ?? null
    let passwordSetupUrl: string | undefined
    if (auth0Result?.created && userId) {
      passwordSetupUrl =
        (await createAuth0PasswordChangeTicket(userId, `${baseUrl}/welcome`, env)) ??
        undefined
      if (!passwordSetupUrl) {
        console.error('[auth0] new member created but password-change ticket failed:', email)
      }
    }
    return { userId, created: auth0Result?.created ?? false, passwordSetupUrl }
  }

  // Provision the Supporting Cast feed (the arkPlus axis). Preserves the
  // cross-instance race guard: between the caller's metadata read and here, the
  // SC user lookup adds network time in which another instance (webhook racing
  // /api/auth/checkout-session) may have finished — re-check the sub before
  // POSTing a fresh SC subscription. Returns the SC ids for the membership row.
  const provisionSc = async (
    subId: string,
    email: string,
    name: string | undefined,
    plan: Plan,
  ): Promise<{ scUserId: number; scSubscriptionId: number }> => {
    const scPriceId = resolveScPriceId(plan)
    const sc = createScClient(env)
    const user = await findOrCreateScUser(sc, email, name)

    const recheck = await stripe!.subscriptions.retrieve(subId)
    if (recheck.metadata?.sc_subscription_id) {
      return {
        scUserId: recheck.metadata.sc_user_id
          ? Number(recheck.metadata.sc_user_id)
          : user.id,
        scSubscriptionId: Number(recheck.metadata.sc_subscription_id),
      }
    }

    let created: { subscription: { id: number } }
    try {
      created = await sc.call<{ subscription: { id: number } }>(
        'POST',
        '/subscriptions',
        { user_id: user.id, subscription_price_id: Number(scPriceId) },
        { idempotencyKey: `stripe_sub_${subId}` },
      )
    } catch (err) {
      const e = err as { status?: number }
      if (e?.status === 409) throw new AlreadySubscribedError(email)
      throw err
    }
    return { scUserId: user.id, scSubscriptionId: created.subscription.id }
  }

  const doActivateMembership = async (
    subId: string,
    tier: Tier,
  ): Promise<MembershipProvisionResult> => {
    const entitlements = deriveEntitlements(tier)

    // Re-read inside the critical section. The caller's in-memory `sub` snapshot
    // may be stale: another caller could have finished provisioning (and written
    // metadata) between their retrieve and our handler firing.
    const fresh = await stripe!.subscriptions.retrieve(subId)
    const customerId =
      typeof fresh.customer === 'string' ? fresh.customer : fresh.customer.id
    const customer = await stripe!.customers.retrieve(customerId)
    if (customer.deleted) throw new Error('Stripe customer was deleted')
    const activeCustomer = customer as Stripe.Customer
    const email = activeCustomer.email
    if (!email) throw new Error('Stripe customer has no email')
    const name = activeCustomer.name ?? undefined
    const plan = (fresh.metadata?.plan as Plan | undefined) ?? 'yearly'
    const baseUrl = env.APP_BASE_URL || 'http://localhost:5173'

    // First activation = no axis has a provisioning marker yet. Gates the single
    // welcome email + Beehiiv push so a later webhook delivery (completing a
    // partially-failed axis) doesn't re-send them.
    const wasUnprovisioned =
      !fresh.metadata?.sc_subscription_id &&
      !fresh.metadata?.auth0_user_id &&
      fresh.metadata?.circle_provisioned !== 'true'

    let scUserId = fresh.metadata?.sc_user_id ? Number(fresh.metadata.sc_user_id) : null
    let scSubscriptionId = fresh.metadata?.sc_subscription_id
      ? Number(fresh.metadata.sc_subscription_id)
      : null

    // SC (arkPlus) first, so a later Auth0/Circle outage can never block feed
    // access — the paid product (§3 "the ordering trap").
    if (entitlements.arkPlus && scSubscriptionId == null) {
      const provisioned = await provisionSc(subId, email, name, plan)
      scUserId = provisioned.scUserId
      scSubscriptionId = provisioned.scSubscriptionId
    }

    // Auth0 login for every paid tier. Reuse an already-stamped login.
    let auth0Sub: string | null = fresh.metadata?.auth0_user_id ?? null
    let passwordSetupUrl: string | undefined
    if (!auth0Sub) {
      const login = await ensureAuth0Login(email, name, baseUrl)
      auth0Sub = login.userId
      passwordSetupUrl = login.passwordSetupUrl
    }

    // Circle (circle axis): create the member pre-SSO, stamp auth0_sub, add to
    // the access group. Soft — a Circle hiccup must not fail the whole webhook.
    let circleProvisioned = fresh.metadata?.circle_provisioned === 'true'
    if (entitlements.circle && !circleProvisioned) {
      const status = await provisionCircleMember(env, email, name, auth0Sub)
      circleProvisioned = status === 'ok'
    }

    // Stamp resolved ids + idempotency markers back onto the sub. The webhook
    // reads sc_user_id / auth0_user_id back off this for the membership row.
    await stripe!.subscriptions.update(fresh.id, {
      metadata: {
        ...fresh.metadata,
        ...(scUserId != null ? { sc_user_id: String(scUserId) } : {}),
        ...(scSubscriptionId != null
          ? { sc_subscription_id: String(scSubscriptionId) }
          : {}),
        ...(auth0Sub ? { auth0_user_id: auth0Sub } : {}),
        ...(circleProvisioned ? { circle_provisioned: 'true' } : {}),
      },
    })

    if (wasUnprovisioned) {
      // One branded welcome email — replaces both the SC welcome email (feed
      // setup lives on /welcome) and Auth0's reset email (link embedded above).
      // arkPlus tiers get the feed-first copy (it also covers the bundle's
      // community); Circle-only gets community-first copy. Soft-fail: the
      // membership is already provisioned.
      const { subject, html } = entitlements.arkPlus
        ? renderSubscriberWelcomeEmail({
            name,
            welcomeUrl: `${baseUrl}/welcome`,
            passwordSetupUrl,
          })
        : renderCircleWelcomeEmail({
            name,
            welcomeUrl: `${baseUrl}/welcome`,
            passwordSetupUrl,
          })
      const sent = await sendEmail(env, { to: email, subject, html })
      if (!sent) {
        console.error('[email] member welcome email did not send:', email)
      }

      // Beehiiv premium letter gates on arkPlus (task 11), so Circle-only does
      // not get it. Soft-fail: entitlement already landed; the reconciler /
      // next /account/newsletters edit repairs drift.
      if (entitlements.arkPlus && env.DATABASE_URL) {
        await tryPush('ensure premium (sub)', () =>
          ensureSubscribedWithPremium({ env, sql: getDb(env) }, email),
        )
      }
    }

    return { email, name, tier, plan, auth0Sub, scUserId, scSubscriptionId }
  }

  const activateMembershipForStripeSub = async (
    sub: Stripe.Subscription,
    tier: Tier,
  ): Promise<MembershipProvisionResult> => {
    if (!stripe) {
      return {
        email: '',
        tier,
        plan: 'yearly',
        auth0Sub: null,
        scUserId: null,
        scSubscriptionId: null,
      }
    }

    // Fast path: every external grant this tier needs is already marked on the
    // sub. Avoids the retrieve/retrieve/update round-trips on the many
    // metadata-only customer.subscription.updated events Stripe fires. Keyed on
    // the external-grant markers (sc_subscription_id / circle_provisioned), not
    // auth0_user_id — the login is best-effort and stamped alongside them on the
    // first activation, so requiring it here would re-provision legacy subs that
    // predate the stamp.
    const need = deriveEntitlements(tier)
    const m = sub.metadata ?? {}
    const fullyProvisioned =
      (need.arkPlus || need.circle) &&
      (!need.arkPlus || Boolean(m.sc_subscription_id)) &&
      (!need.circle || m.circle_provisioned === 'true')
    if (fullyProvisioned) {
      return {
        email: '',
        tier,
        plan: (m.plan as Plan | undefined) ?? 'yearly',
        auth0Sub: m.auth0_user_id ?? null,
        scUserId: m.sc_user_id ? Number(m.sc_user_id) : null,
        scSubscriptionId: m.sc_subscription_id ? Number(m.sc_subscription_id) : null,
      }
    }

    // Per-instance dedup: a second caller for the same sub awaits the first's
    // promise (and its resolved ids) rather than re-provisioning.
    const existing = provisionInFlight.get(sub.id)
    if (existing) return existing

    const promise = doActivateMembership(sub.id, tier).finally(() => {
      provisionInFlight.delete(sub.id)
    })
    provisionInFlight.set(sub.id, promise)
    return promise
  }

  const activateScSubscriptionForStripeSub = async (
    sub: Stripe.Subscription,
  ): Promise<void> => {
    // Back-compat: the only tier sold through the pre-task-8 checkout is Ark+.
    // Task 9 makes the webhook (and the post-checkout auth route) derive the
    // tier from the price product's entitlements metadata.
    await activateMembershipForStripeSub(sub, 'ark-plus')
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

    // Create the Auth0 login but suppress Auth0's own reset email — our single
    // welcome email below carries the set-password link instead.
    let auth0Result: Awaited<ReturnType<typeof findOrCreateAuth0User>> = null
    try {
      auth0Result = await findOrCreateAuth0User(recipientEmail, recipientName, env, {
        emailPasswordReset: false,
      })
    } catch (err) {
      console.error('[auth0] findOrCreateAuth0User (gift) failed:', err)
    }
    const auth0UserId = auth0Result?.userId ?? null

    // New accounts get a password-change ticket embedded in the email; existing
    // accounts already have a login, so the email points them at sign-in.
    const baseUrl = env.APP_BASE_URL || 'http://localhost:5173'
    let passwordSetupUrl: string | undefined
    if (auth0Result?.created && auth0UserId) {
      passwordSetupUrl =
        (await createAuth0PasswordChangeTicket(
          auth0UserId,
          `${baseUrl}/welcome`,
          env,
        )) ?? undefined
      if (!passwordSetupUrl) {
        console.error(
          '[auth0] gift recipient created but password-change ticket failed:',
          recipientEmail,
        )
      }
    }

    await stripe.paymentIntents.update(pi.id, {
      metadata: {
        ...pi.metadata,
        sc_user_id: String(recipient.id),
        sc_subscription_id: String(createdSub.subscription.id),
        ...(auth0UserId ? { auth0_user_id: auth0UserId } : {}),
      },
    })

    // One branded welcome email — replaces both the SC welcome email (feed
    // setup now lives on /welcome) and Auth0's reset email (link embedded
    // above). Soft-fail: the gift is already granted.
    const { subject, html } = renderGiftWelcomeEmail({
      recipientName,
      giverName,
      term,
      message,
      welcomeUrl: `${baseUrl}/welcome`,
      passwordSetupUrl,
    })
    const sent = await sendEmail(env, { to: recipientEmail, subject, html })
    if (!sent) {
      console.error('[email] gift welcome email did not send:', recipientEmail)
    }

    // Mirror the Circle axis (an ark-plus gift grants none, so this is a no-op
    // here). The gift's SC sub already carries ends_at; gift expiry now lives on
    // the Neon membership row written at redemption (task 9), not Auth0.
    await syncEntitlement(env, recipientEmail, 'ark-plus')

    if (env.DATABASE_URL) {
      await tryPush('ensure premium (gift)', () =>
        ensureSubscribedWithPremium({ env, sql: getDb(env) }, recipientEmail),
      )
    }
  }

  const activateGiftForRecipient = async (opts: {
    email: string
    name?: string
    tier: Tier
    term: GiftTerm
    auth0Sub: string | null
  }): Promise<{ scUserId: number | null; scSubscriptionId: number | null; endsAt: string }> => {
    const entitlements = deriveEntitlements(opts.tier)
    const endsAt = new Date(
      Date.now() + GIFT_TERM_DAYS[opts.term] * 24 * 60 * 60 * 1000,
    ).toISOString()

    let scUserId: number | null = null
    let scSubscriptionId: number | null = null
    if (entitlements.arkPlus) {
      const sc = createScClient(env)
      const user = await findOrCreateScUser(sc, opts.email, opts.name)
      const scPriceId = resolveScGiftPriceId(opts.term)
      // Idempotency key ties the SC gift sub to (recipient, term) so a redeem
      // retry returns the existing record rather than stacking a second.
      const created = await sc.call<{ subscription: { id: number } }>(
        'POST',
        '/subscriptions',
        { user_id: user.id, subscription_price_id: Number(scPriceId), ends_at: endsAt },
        { idempotencyKey: `gift_redeem_${opts.auth0Sub ?? opts.email}_${opts.term}` },
      )
      scUserId = user.id
      scSubscriptionId = created.subscription.id
    }
    if (entitlements.circle) {
      await provisionCircleMember(env, opts.email, opts.name, opts.auth0Sub)
    }
    return { scUserId, scSubscriptionId, endsAt }
  }

  return {
    activateMembershipForStripeSub,
    activateScSubscriptionForStripeSub,
    activateScGiftForPaymentIntent,
    activateGiftForRecipient,
  }
}
