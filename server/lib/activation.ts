// Membership / gift activation.
//
// The arkPlus axis is granted by applying Beehiiv's premium "Plus" tier to the
// member's subscriber record — Beehiiv issues the private podcast feed off that
// tier. The grant is idempotent on the member's email (look up → create or
// update), so two callers racing the same checkout converge on one record and
// no create-dedup is needed here.
//
//
// Two callers do still race for the same Stripe sub: the webhook (eventually
// consistent) and /api/auth/checkout-session (called by the SPA right after
// confirmPayment). `provisionInFlight` collapses them within one process; the
// Stripe metadata markers collapse them across instances.

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
import { redactEmail } from '../../shared/validation.js'
import { splitFullName } from '../../shared/profile-name.js'

type Env = Record<string, string>
type Plan = 'monthly' | 'yearly'

// Gift purchases — a one-time Stripe charge granting a fixed term. Term-length
// policy lives here so the activator owns it; the charge AMOUNT comes from the
// Stripe catalog gift Price (server/lib/pricing.ts resolveGiftPrice), not a
// hardcoded USD table. The term itself is enforced by us (the Neon row's
// per-axis expiry + the reconciler), because neither Beehiiv nor Circle holds
// an end date.
export type GiftTerm = '6mo' | '1yr'

export const GIFT_TERM_DAYS: Record<GiftTerm, number> = {
  '6mo': 182,
  '1yr': 365,
}

// The `welcomed_axes` stamp, in the same comma-separated vocabulary the
// catalog's product metadata uses. Stripe stores metadata as strings, and an
// empty value would read back as an absent key, so a member welcomed for
// nothing (which cannot happen — every paid tier grants at least one axis)
// would be indistinguishable from an unstamped subscription.
function parseAxes(welcomedAxes: string | undefined): Set<string> {
  return new Set(
    (welcomedAxes ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
  )
}

// What the member has now been TOLD they hold: everything an earlier email
// covered, plus the axes the email this activation is about to send names.
//
// It accumulates rather than overwrites, and it is written on both send paths.
// Stamping only the first activation was the bug: a Circle-only member who
// added Ark+ got the upgrade email and kept the stamp `circle`, so the record
// of what they had been told never caught up with what they had been told.
function welcomedAxesValue(
  existing: string | undefined,
  entitlements: Entitlements,
): string {
  const axes = parseAxes(existing)
  if (entitlements.arkPlus) axes.add('ark_plus')
  if (entitlements.circle) axes.add('circle')
  // Canonical order, so the stamp reads identically however it accumulated.
  return ['ark_plus', 'circle'].filter((a) => axes.has(a)).join(',')
}

// Whether an axis that just finished provisioning is one the member did NOT
// already own when they were welcomed — i.e. a real upgrade, not the second
// half of the purchase they already have an email about.
//
// A subscription with no stamp at all predates the stamp, so nothing is known
// about what its welcome covered. Treated as "welcomed for nothing", which errs
// toward sending: an upgrade that goes unannounced is the silence this branch
// was added to fix, and a stray email is the cheaper mistake of the two.
//
// Note what this cannot see: an axis the member held, lost, and bought back is
// still in the stamp, so the re-purchase is silent. Fixing that means clearing
// the axis when the entitlement is removed, which belongs on the downgrade
// path, not here.
function gainedAxis(
  welcomedAxes: string | undefined,
  provisionedNow: { arkPlus: boolean; circle: boolean },
): boolean {
  const welcomed = parseAxes(welcomedAxes)
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
// write the Neon membership row: `auth0Sub` keys it, `plan`/`tier` describe the
// SKU. `auth0Sub` is null when the login provisioning soft-failed (Auth0 down)
// — the caller must not write a row without one.
//
// No arkPlus id comes back: the Beehiiv grant is keyed on the member's email,
// which the row already carries by way of Auth0, so there is nothing opaque to
// hand on.
type MembershipProvisionResult = {
  email: string
  name?: string
  tier: Tier
  plan: Plan
  auth0Sub: string | null
}

export type Activator = {
  // Tier-aware provisioning: Auth0 login for every paid tier, the Beehiiv
  // premium tier only when the tier grants arkPlus, Circle only when it grants
  // circle. Returns what the webhook needs for the membership row. Idempotent
  // per axis (keyed on sub metadata markers).
  activateMembershipForStripeSub: (
    sub: Stripe.Subscription,
    tier: Tier,
  ) => Promise<MembershipProvisionResult>
  // Grant a redeemed gift to the signed-in recipient (routes/gift.ts), one axis
  // at a time (D4): the redeem flow decides WHICH axes this gift extends (a
  // Bundle gift extends both; a gift overlapping a paid sub extends only the
  // axis the sub lacks). Beehiiv's premium tier covers the arkPlus axis, Circle
  // the circle axis. Returns the per-axis expiry for the membership row.
  activateGiftForRecipient: (opts: {
    email: string
    name?: string
    auth0Sub: string | null
    term: GiftTerm
    // The gift's redemption token. Retained for logging and for the caller's
    // own idempotency; the grant is a boolean tier, so there is nothing here
    // to accidentally collapse two distinct gifts into.
    giftToken: string
    // Epoch ms each axis's term is measured from — null means "don't grant this
    // axis". The redeem flow passes an existing unexpired gift expiry so a
    // stacked same-axis gift extends rather than resets; the returned per-axis
    // endsAt is measured from it.
    arkPlusFromMs: number | null
    circleFromMs: number | null
  }) => Promise<{
    arkPlusEndsAt: string | null
    circleEndsAt: string | null
  }>
}

export function createActivator(env: Env, stripe: Stripe | null): Activator {
  const provisionInFlight = new Map<string, Promise<MembershipProvisionResult>>()

  // Create the Auth0 login for a paid member (any tier), suppressing Auth0's own
  // reset email — the single welcome email carries the set-password link. Soft-
  // fails to a null userId so an Auth0 outage can't block the paid product; the
  // webhook then can't write a membership row and retries. Runs for every paid
  // tier, not just Ark+ — a Circle-only buyer needs a login to SSO into what
  // they bought (§8 risk 6).
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

  // Provision the arkPlus axis: create (or upgrade) the member's Beehiiv
  // subscriber and put them on the premium "Plus" tier, which is what entitles
  // them to the private podcast feed and the members' letter.
  //
  // Answers whether the grant landed. `false` means Beehiiv isn't configured in
  // this environment (preview, tests) — not that it failed, which throws and
  // leaves the marker unstamped so a webhook redelivery retries. Either way the
  // caller must not claim the axis on a `false`.
  const provisionArkPlus = async (email: string): Promise<boolean> =>
    ensureSubscribedWithPremium(
      { env, sql: env.DATABASE_URL ? getDb(env) : null },
      email,
    )

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
    // welcome email so a later webhook delivery (completing a partially-failed
    // axis) doesn't re-send it.
    const wasUnprovisioned =
      fresh.metadata?.beehiiv_premium !== 'true' &&
      !fresh.metadata?.auth0_user_id &&
      fresh.metadata?.circle_provisioned !== 'true'

    // Beehiiv premium (arkPlus) first, so a later Auth0/Circle outage can never
    // block feed access — the paid product (§3 "the ordering trap").
    // `addingArkPlus` records that THIS call is what grants the axis, which is
    // what separates an upgrade from a redelivery; the axis markers are stamped
    // below, so a later fan-out sees the axis already provisioned and reports
    // false. Paired with the success check at the send site, the axis-added
    // email fires only on the transition into the entitlement.
    let arkPlusGranted = fresh.metadata?.beehiiv_premium === 'true'
    const addingArkPlus = entitlements.arkPlus && !arkPlusGranted
    if (addingArkPlus) {
      arkPlusGranted = await provisionArkPlus(email)
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

    // The axes the member has been told about — the thing that separates a
    // genuine upgrade from a first purchase whose provisioning had to be
    // retried. Both look identical to `addingCircle` / `addingArkPlus`: a Bundle
    // buyer whose Circle add failed and succeeded on a redelivery is "adding
    // circle" on that second pass, even though they bought it minutes ago and
    // were already welcomed for it. Comparing against what they were welcomed
    // FOR is what tells the two apart. Vocabulary matches the catalog's
    // `entitlements` metadata (see tierFromEntitlementString).
    //
    // Read off `fresh.metadata` BEFORE the stamp below overwrites it, since the
    // stamp is now written on the upgrade path too and would otherwise erase
    // the very difference the send is gated on.
    const gainedNewAxis = gainedAxis(fresh.metadata?.welcomed_axes, {
      arkPlus: addingArkPlus && arkPlusGranted,
      circle: addingCircle && circleProvisioned,
    })
    const welcomedAxes = welcomedAxesValue(fresh.metadata?.welcomed_axes, entitlements)

    // Stamp the idempotency markers back onto the sub. The webhook reads
    // auth0_user_id back off this for the membership row, and `beehiiv_premium`
    // is what stops a redelivery re-granting (and re-announcing) the arkPlus
    // axis. Stamped only when the grant actually landed, so a Beehiiv outage
    // leaves the sub unmarked and the next delivery retries it.
    await stripe!.subscriptions.update(fresh.id, {
      metadata: {
        ...fresh.metadata,
        ...(arkPlusGranted ? { beehiiv_premium: 'true' } : {}),
        ...(auth0Sub ? { auth0_user_id: auth0Sub } : {}),
        ...(circleProvisioned ? { circle_provisioned: 'true' } : {}),
        // Both send paths record what they announced. Only the first activation
        // used to, which left the stamp permanently behind on any member who
        // ever upgraded.
        ...(wasUnprovisioned || gainedNewAxis ? { welcomed_axes: welcomedAxes } : {}),
      },
    })

    if (wasUnprovisioned) {
      // One branded welcome email — feed setup lives on /welcome, and it stands
      // in for Auth0's reset email too (link embedded above).
      // One per tier: bundle (feed + Fold) and ark-plus (feed only) share
      // the subscriber template but branch on tier for accurate copy;
      // Circle-only gets the Fold-first copy. Soft-fail: the membership is
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

      // Carry the name the buyer entered at checkout onto their Beehiiv record
      // so campaigns can personalize from the first send. Soft-fail, and a no-op
      // when Stripe gave us no name.
      if (name && env.DATABASE_URL) {
        const { first, last } = splitFullName(name)
        await tryPush('sync subscriber name', () =>
          syncSubscriberName({ env, sql: getDb(env) }, email, { first, last }),
        )
      }
    } else if (gainedNewAxis) {
      // An already-provisioned member who just gained an axis — an Ark+ member
      // adding the Fold (or the reverse), which moves their subscription onto
      // the Bundle. `wasUnprovisioned` deliberately keeps the welcome copy away
      // from them, which until now left the upgrade completely silent: no
      // branded email, no pointer to the thing they just bought, and no notice
      // of the new recurring price (Stripe's receipt doesn't arrive until the
      // next invoice, since the change is prorated onto it).
      //
      // Gated (see gainedNewAxis above) on the provisioning having SUCCEEDED,
      // not merely been attempted: "the Fold is yours now" must not go out
      // while the Circle add is still failing. A retry that finally succeeds
      // sends it then.
      //
      // And gated on the axis being one the member did NOT already buy. Without
      // that, a Bundle purchase whose Circle add failed the first time and
      // landed on a redelivery sent its brand-new buyer an upgrade email
      // minutes after their welcome — "You just added the Fold" and
      // "Nothing to pay today", to someone who added nothing and paid in full
      // that morning.

      // Circle wins when both landed at once: its copy is the one that names the
      // Fold, and the price sentence covers the whole Bundle either way.
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
    }

    return { email, name, tier, plan, auth0Sub }
  }

  const activateMembershipForStripeSub = async (
    sub: Stripe.Subscription,
    tier: Tier,
  ): Promise<MembershipProvisionResult> => {
    if (!stripe) {
      return { email: '', tier, plan: 'yearly', auth0Sub: null }
    }

    // Fast path: every external grant this tier needs is already marked on the
    // sub. Avoids the retrieve/retrieve/update round-trips on the many
    // metadata-only customer.subscription.updated events Stripe fires. Keyed on
    // the external-grant markers (beehiiv_premium / circle_provisioned), not
    // auth0_user_id — the login is best-effort and stamped alongside them on the
    // first activation, so requiring it here would re-provision legacy subs that
    // predate the stamp.
    const need = deriveEntitlements(tier)
    const m = sub.metadata ?? {}
    const fullyProvisioned =
      (need.arkPlus || need.circle) &&
      (!need.arkPlus || m.beehiiv_premium === 'true') &&
      (!need.circle || m.circle_provisioned === 'true')
    if (fullyProvisioned) {
      return {
        email: '',
        tier,
        plan: (m.plan as Plan | undefined) ?? 'yearly',
        auth0Sub: m.auth0_user_id ?? null,
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
    arkPlusEndsAt: string | null
    circleEndsAt: string | null
  }> => {
    const termMs = GIFT_TERM_DAYS[opts.term] * 24 * 60 * 60 * 1000
    let arkPlusEndsAt: string | null = null
    let circleEndsAt: string | null = null

    if (opts.arkPlusFromMs != null) {
      arkPlusEndsAt = new Date(opts.arkPlusFromMs + termMs).toISOString()
      // ⚠ The grant carries NO end date upstream. Beehiiv's premium tier is a
      // boolean with no term of its own, so the ONLY thing that ever ends a
      // gifted feed is `ark_plus_gift_expires_at` on the Neon row plus the
      // reconciler's downgrade pass. If that pass is
      // disabled or silently failing, expired recipients keep their feed
      // indefinitely and nothing surfaces it.
      await provisionArkPlus(opts.email)
    }
    if (opts.circleFromMs != null) {
      circleEndsAt = new Date(opts.circleFromMs + termMs).toISOString()
      await provisionCircleMember(env, opts.email, opts.name, opts.auth0Sub)
    }
    return { arkPlusEndsAt, circleEndsAt }
  }

  return {
    activateMembershipForStripeSub,
    activateGiftForRecipient,
  }
}
