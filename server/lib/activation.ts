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
  type Entitlements,
  type Tier,
} from '../entitlement.js'
import {
  createAuth0PasswordChangeTicket,
  findOrCreateAuth0User,
} from './auth0-user.js'
import {
  ensureSubscribedWithPremium,
  syncSubscriberName,
  tryPush,
} from './beehiiv-sync.js'
import { getDb } from './db.js'
import { sendEmail } from './email.js'
import {
  renderAxisAddedEmail,
  renderCircleWelcomeEmail,
  renderSubscriberWelcomeEmail,
} from './welcome-email.js'
import { formatMinorUnits } from './pricing.js'
import { EMAIL_TIME_ZONE, formatTimestampInZone } from '../../shared/format-date.js'
import { createScClient, findOrCreateScUser } from './sc-client.js'
import { redactEmail } from '../../shared/validation.js'
import { splitFullName } from '../../shared/profile-name.js'

type Env = Record<string, string>
type Plan = 'monthly' | 'yearly'

// Gift purchases — one-time Stripe charge, fixed-term SC subscription
// stamped with ends_at. Term-length policy lives here so the activator owns it;
// the charge AMOUNT now comes from the Stripe catalog gift Price
// (server/lib/pricing.ts resolveGiftPrice), not a hardcoded USD table.
export type GiftTerm = '6mo' | '1yr'

export const GIFT_TERM_DAYS: Record<GiftTerm, number> = {
  '6mo': 182,
  '1yr': 365,
}

// The `welcomed_axes` stamp: which axes the welcome email covered, in the same
// comma-separated vocabulary the catalog's product metadata uses. Stripe stores
// metadata as strings, and an empty value would read back as an absent key, so
// a member welcomed for nothing (which cannot happen — every paid tier grants
// at least one axis) would be indistinguishable from an unstamped subscription.
function axesMetadataValue(entitlements: Entitlements): string {
  const axes: string[] = []
  if (entitlements.arkPlus) axes.push('ark_plus')
  if (entitlements.circle) axes.push('circle')
  return axes.join(',')
}

// Whether an axis that just finished provisioning is one the member did NOT
// already own when they were welcomed — i.e. a real upgrade, not the second
// half of the purchase they already have an email about.
//
// A subscription with no stamp at all predates the stamp, so nothing is known
// about what its welcome covered. Treated as "welcomed for nothing", which errs
// toward sending: an upgrade that goes unannounced is the silence this branch
// was added to fix, and a stray email is the cheaper mistake of the two.
function gainedAxis(
  welcomedAxes: string | undefined,
  provisionedNow: { arkPlus: boolean; circle: boolean },
): boolean {
  const welcomed = new Set(
    (welcomedAxes ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
  )
  if (provisionedNow.circle && !welcomed.has('circle')) return true
  if (provisionedNow.arkPlus && !welcomed.has('ark_plus')) return true
  return false
}

// The billing facts an axis-added email states, read off the subscription the
// change has already landed on.
//
// The price is DROPPED rather than guessed when it can't be read in the
// currency the member is actually charged in: `unit_amount` is stated in the
// PRICE's own currency, which for a catalog price billed through
// `currency_options` is the USD base, not what they pay. change-tier stamps
// `amount_cents` + `currency` alongside the item it writes, so the metadata
// covers exactly that case.
function billingFactsFor(sub: Stripe.Subscription): {
  price?: string
  plan: Plan
  renewsOn?: string
} {
  const item = sub.items?.data?.[0]
  const interval = item?.price?.recurring?.interval
  const plan: Plan =
    interval === 'month'
      ? 'monthly'
      : interval === 'year'
        ? 'yearly'
        : ((sub.metadata?.plan as Plan | undefined) ?? 'yearly')

  const live = item?.price
  const rawAmount = sub.metadata?.amount_cents
  const metaAmount = rawAmount ? Number(rawAmount) : Number.NaN
  let price: string | undefined
  if (live && live.currency === sub.currency && typeof live.unit_amount === 'number') {
    price = formatMinorUnits(live.unit_amount, sub.currency)
  } else if (sub.metadata?.currency === sub.currency && Number.isFinite(metaAmount)) {
    price = formatMinorUnits(metaAmount, sub.currency)
  }

  // A member who added an axis while a cancel is already pending doesn't renew
  // on that date — they lose access on it. Say nothing rather than the opposite.
  const periodEnd = item?.current_period_end
  const renewsOn =
    !sub.cancel_at_period_end && typeof periodEnd === 'number' && Number.isFinite(periodEnd)
      ? formatTimestampInZone(
          new Date(periodEnd * 1000).toISOString(),
          EMAIL_TIME_ZONE,
          'long',
        )
      : ''

  return { price, plan, renewsOn: renewsOn || undefined }
}

// What a paid-tier activation resolved to. The webhook (task 9) reads this to
// write the Neon membership row: `auth0Sub` keys it, `scUserId` is the arkPlus
// join key, `plan`/`tier` describe the SKU. Any field is null when its axis
// wasn't granted or its provisioning soft-failed (Auth0 down, no SC feed for a
// Circle-only tier) — the caller must not write a row without an `auth0Sub`.
type MembershipProvisionResult = {
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
  // Grant a redeemed gift to the signed-in recipient (routes/gift.ts), one axis
  // at a time (D4): the redeem flow decides WHICH axes this gift extends (a
  // Bundle gift extends both; a gift overlapping a paid sub extends only the
  // axis the sub lacks). SC is provisioned for the arkPlus axis, Circle for the
  // circle axis. Returns the SC ids + the per-axis expiry for the membership row.
  activateGiftForRecipient: (opts: {
    email: string
    name?: string
    auth0Sub: string | null
    term: GiftTerm
    // The gift's redemption token — the SC idempotency scope. Keying on the gift
    // (not recipient+term) dedups a RETRY of the same redemption while letting a
    // second, distinct gift mint its own SC subscription instead of silently
    // collapsing into the first (which left its ends_at un-extended).
    giftToken: string
    // Epoch ms each axis's term is measured from — null means "don't grant this
    // axis". The redeem flow passes an existing unexpired gift expiry so a
    // stacked same-axis gift extends rather than resets. The SC gift sub's
    // ends_at (arkPlus) and the returned per-axis endsAt both use these.
    arkPlusFromMs: number | null
    circleFromMs: number | null
  }) => Promise<{
    scUserId: number | null
    scSubscriptionId: number | null
    arkPlusEndsAt: string | null
    circleEndsAt: string | null
  }>
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
        console.error('[auth0] new member created but password-change ticket failed:', redactEmail(email))
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
    // `addingArkPlus` records that THIS call is what grants the axis, which is
    // what separates an upgrade from a redelivery; the axis markers are stamped
    // below, so a later fan-out sees the axis already provisioned and reports
    // false. Paired with the success check at the send site, the axis-added
    // email fires only on the transition into the entitlement.
    const addingArkPlus = entitlements.arkPlus && scSubscriptionId == null
    if (addingArkPlus) {
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
    const addingCircle = entitlements.circle && !circleProvisioned
    if (addingCircle) {
      const status = await provisionCircleMember(env, email, name, auth0Sub)
      circleProvisioned = status === 'ok'
    }

    // The axes the WELCOME email covered — recorded on the first activation, and
    // the thing that separates a genuine upgrade from a first purchase whose
    // provisioning had to be retried. Both look identical to `addingCircle` /
    // `addingArkPlus`: a Bundle buyer whose Circle add failed and succeeded on a
    // redelivery is "adding circle" on that second pass, even though they bought
    // it minutes ago and were already welcomed for it. Comparing against what
    // they were welcomed FOR is what tells the two apart. Vocabulary matches the
    // catalog's `entitlements` metadata (see tierFromEntitlementString).
    const welcomedAxes = axesMetadataValue(entitlements)

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
        ...(wasUnprovisioned ? { welcomed_axes: welcomedAxes } : {}),
      },
    })

    if (wasUnprovisioned) {
      // One branded welcome email — replaces both the SC welcome email (feed
      // setup lives on /welcome) and Auth0's reset email (link embedded above).
      // One per tier: bundle (feed + community) and ark-plus (feed only) share
      // the subscriber template but branch on tier for accurate copy;
      // Circle-only gets the community-first copy. Soft-fail: the membership is
      // already provisioned.
      const { subject, html } = entitlements.arkPlus
        ? renderSubscriberWelcomeEmail({
            name,
            email,
            welcomeUrl: `${baseUrl}/welcome`,
            passwordSetupUrl,
            tier: entitlements.circle ? 'bundle' : 'ark-plus',
          })
        : renderCircleWelcomeEmail({
            name,
            email,
            welcomeUrl: `${baseUrl}/welcome`,
            passwordSetupUrl,
          })
      // Idempotency-keyed on the subscription so two callers on different
      // instances (webhook + post-checkout route) collapse to one welcome email
      // rather than each sending its own.
      const sent = await sendEmail(env, {
        to: email,
        subject,
        html,
        idempotencyKey: `welcome_${fresh.id}`,
      })
      if (!sent) {
        console.error('[email] member welcome email did not send:', redactEmail(email))
      }

      // Beehiiv premium letter gates on arkPlus (task 11), so Circle-only does
      // not get it. Soft-fail: entitlement already landed; the reconciler /
      // next /account/newsletters edit repairs drift.
      if (entitlements.arkPlus && env.DATABASE_URL) {
        await tryPush('ensure premium (sub)', () =>
          ensureSubscribedWithPremium({ env, sql: getDb(env) }, email),
        )
      }

      // Carry the name the buyer entered at checkout onto their Beehiiv record
      // so campaigns can personalize from the first send. Soft-fail, and a no-op
      // when Stripe gave us no name.
      if (name && env.DATABASE_URL) {
        const { first, last } = splitFullName(name)
        await tryPush('sync subscriber name', () =>
          syncSubscriberName({ env, sql: getDb(env) }, email, { first, last }),
        )
      }
    } else if (
      // An already-provisioned member who just gained an axis — an Ark+ member
      // adding Community (or the reverse), which moves their subscription onto
      // the Bundle. `wasUnprovisioned` deliberately keeps the welcome copy away
      // from them, which until now left the upgrade completely silent: no
      // branded email, no pointer to the thing they just bought, and no notice
      // of the new recurring price (Stripe's receipt doesn't arrive until the
      // next invoice, since the change is prorated onto it).
      //
      // Gated on the provisioning having SUCCEEDED, not merely been attempted:
      // "the community is yours now" must not go out while the Circle add is
      // still failing. A retry that finally succeeds sends it then.
      //
      // And gated on the axis being one the member did NOT already buy. Without
      // that, a Bundle purchase whose Circle add failed the first time and
      // landed on a redelivery sent its brand-new buyer an upgrade email
      // minutes after their welcome — "You just added the Ark+ community" and
      // "Nothing to pay today", to someone who added nothing and paid in full
      // that morning.
      gainedAxis(fresh.metadata?.welcomed_axes, {
        arkPlus: addingArkPlus && scSubscriptionId != null,
        circle: addingCircle && circleProvisioned,
      })
    ) {
      // Circle wins when both landed at once: its copy is the one that names the
      // community, and the price sentence covers the whole Bundle either way.
      const axis = addingCircle && circleProvisioned ? 'circle' : 'ark-plus'
      const { subject, html } = renderAxisAddedEmail({
        name,
        email,
        axis,
        welcomeUrl: `${baseUrl}/welcome`,
        ...billingFactsFor(fresh),
      })
      // Keyed on the subscription AND the axis so a webhook retry collapses,
      // while a member who later adds the other axis still hears about it.
      const sent = await sendEmail(env, {
        to: email,
        subject,
        html,
        idempotencyKey: `axis_added_${fresh.id}_${axis}`,
      })
      if (!sent) {
        console.error('[email] axis-added email did not send:', redactEmail(email))
      }

      // The premium letter gates on the arkPlus axis, so a Circle-only member
      // who just added Ark+ needs the same push the first-time path does.
      if (addingArkPlus && entitlements.arkPlus && env.DATABASE_URL) {
        await tryPush('ensure premium (axis added)', () =>
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

  const activateGiftForRecipient = async (opts: {
    email: string
    name?: string
    auth0Sub: string | null
    term: GiftTerm
    giftToken: string
    arkPlusFromMs: number | null
    circleFromMs: number | null
  }): Promise<{
    scUserId: number | null
    scSubscriptionId: number | null
    arkPlusEndsAt: string | null
    circleEndsAt: string | null
  }> => {
    const termMs = GIFT_TERM_DAYS[opts.term] * 24 * 60 * 60 * 1000
    let scUserId: number | null = null
    let scSubscriptionId: number | null = null
    let arkPlusEndsAt: string | null = null
    let circleEndsAt: string | null = null

    if (opts.arkPlusFromMs != null) {
      arkPlusEndsAt = new Date(opts.arkPlusFromMs + termMs).toISOString()
      const sc = createScClient(env)
      const user = await findOrCreateScUser(sc, opts.email, opts.name)
      const scPriceId = resolveScGiftPriceId(opts.term)
      // Idempotency key ties the SC gift sub to THIS gift (its redemption token),
      // so a redeem retry returns the existing record while a second, distinct
      // gift creates its own fixed-term subscription — feed access is the union
      // of their ends_at. (The old recipient+term key silently collapsed two
      // gifts into one, leaving the stacked ends_at un-extended on SC.)
      const created = await sc.call<{ subscription: { id: number } }>(
        'POST',
        '/subscriptions',
        { user_id: user.id, subscription_price_id: Number(scPriceId), ends_at: arkPlusEndsAt },
        { idempotencyKey: `gift_redeem_${opts.giftToken}` },
      )
      scUserId = user.id
      scSubscriptionId = created.subscription.id
    }
    if (opts.circleFromMs != null) {
      circleEndsAt = new Date(opts.circleFromMs + termMs).toISOString()
      await provisionCircleMember(env, opts.email, opts.name, opts.auth0Sub)
    }
    return { scUserId, scSubscriptionId, arkPlusEndsAt, circleEndsAt }
  }

  return {
    activateMembershipForStripeSub,
    activateGiftForRecipient,
  }
}
