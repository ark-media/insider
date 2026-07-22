// Backfill the Neon `membership` table (task 7) so that when /api/me and the
// other gates cut over to Neon-as-authority (tasks 10/11), nobody who is
// entitled reads `free`. Standalone (NOT run inside a migration), idempotent
// (upsert), and TEST MODE ONLY — the whole redesign is sandbox-scoped (§1b).
//
// Three passes, in precedence order (a later pass never overwrites a row an
// earlier, richer pass wrote — tracked via `covered`):
//
//   A. Stripe subscriptions (active / trialing / past_due) — the real source.
//      Tier from the price product's `entitlements` metadata; sc_user_id from
//      the sub metadata; auth0_sub from the sub metadata or resolved by email.
//      When one person has several subs, the best one wins (see rank()).
//   B. Supporting Cast members with NO Stripe subscription — gift recipients and
//      SC-fed comps/staff (§8 risk 3). Written as Ark+ so they keep the feed;
//      gift_expires_at is left null (perpetual) rather than risk a wrong expiry.
//   C. Auth0 users still carrying the legacy `app_metadata.tier` shim with no
//      Stripe sub and no SC feed — pure comps/staff. Written as Ark+.
//
// Usage (Bun auto-loads .env; STRIPE_SECRET_KEY / DATABASE_URL / SC_* / AUTH0_*
// must be set there):
//   bun run scripts/backfill-membership.ts            # preview (no writes)
//   bun run scripts/backfill-membership.ts --apply    # write rows

import Stripe from 'stripe'
import { neon } from '@neondatabase/serverless'
import { getManagementClient } from '../server/auth0.js'
import { emailForStripeCustomer, tierFromEntitlementString, type Tier } from '../server/entitlement.js'
import {
  createScV1Client,
  loadAllMemberships,
  type ScMembership,
} from '../server/lib/sc-client.js'
import { upsertMembership, type MembershipUpsert } from '../server/lib/membership.js'

type Env = Record<string, string>

function assertTestMode(key: string | undefined): asserts key is string {
  if (!key || !key.startsWith('sk_test_')) {
    console.error(
      'Refusing to run: STRIPE_SECRET_KEY must be a test key (sk_test_…). ' +
        'This redesign is test-mode only (§1b).',
    )
    process.exit(1)
  }
}

// Best-sub ranking for the multi-sub tie-break: a healthier status wins, then a
// later period end, then the richer tier (more entitlements).
const STATUS_RANK: Record<string, number> = { active: 3, trialing: 2, past_due: 1 }
function rank(sub: Stripe.Subscription, tier: Tier): number {
  const status = STATUS_RANK[sub.status] ?? 0
  const periodEnd = sub.items.data[0]?.current_period_end ?? 0
  const tierWeight = tier === 'bundle' ? 2 : tier === 'free' ? 0 : 1
  return status * 1e12 + periodEnd + tierWeight
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const env = process.env as Env

  assertTestMode(env.STRIPE_SECRET_KEY)
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required.')
    process.exit(1)
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY)
  const sql = neon(env.DATABASE_URL)
  const mgmt = getManagementClient(env)

  console.log(apply ? '=== APPLY (writing membership rows) ===' : '=== PREVIEW (no writes) ===')

  // --- shared resolvers ------------------------------------------------------
  const productEntitlementCache = new Map<string, string>()
  const tierForSub = async (sub: Stripe.Subscription): Promise<Tier> => {
    const productRef = sub.items.data[0]?.price?.product
    if (!productRef) return tierFromEntitlementString(sub.metadata?.tier)
    const productId = typeof productRef === 'string' ? productRef : productRef.id
    let entitlements = productEntitlementCache.get(productId)
    if (entitlements === undefined) {
      const product = await stripe.products.retrieve(productId)
      entitlements = ('deleted' in product && product.deleted ? '' : product.metadata?.entitlements) ?? ''
      productEntitlementCache.set(productId, entitlements)
    }
    const derived = tierFromEntitlementString(entitlements)
    if (derived !== 'free') return derived
    // Legacy sandbox subs pre-date the catalog — their ad-hoc products carry no
    // `entitlements` metadata. A Stripe subscription is never "free," and the
    // only pre-redesign tier was Ark+, so fall back to the stamped tier then Ark+.
    const stamped = tierFromEntitlementString(sub.metadata?.tier)
    return stamped !== 'free' ? stamped : 'ark-plus'
  }

  const auth0SubCache = new Map<string, string | null>()
  const auth0SubForEmail = async (email: string): Promise<string | null> => {
    const key = email.toLowerCase()
    const hit = auth0SubCache.get(key)
    if (hit !== undefined) return hit
    let resolved: string | null = null
    if (mgmt) {
      try {
        const users = await mgmt.users.listUsersByEmail({ email: key })
        // The post-merge primary is the DB-connection (auth0|…) identity when
        // present, else the first identity.
        const primary = users.find((u) => u.user_id?.startsWith('auth0|')) ?? users[0]
        resolved = primary?.user_id ?? null
      } catch (err) {
        console.error(`  [auth0] lookup failed for ${key}:`, err)
      }
    }
    auth0SubCache.set(key, resolved)
    return resolved
  }

  const covered = new Set<string>()
  let written = 0
  const write = async (row: MembershipUpsert, label: string): Promise<void> => {
    if (covered.has(row.auth0_sub)) return
    covered.add(row.auth0_sub)
    console.log(`  ${label}: ${row.auth0_sub} → ${row.tier} (${row.status})`)
    if (apply) await upsertMembership(sql, row)
    written += 1
  }

  // --- Pass A: Stripe subscriptions -----------------------------------------
  console.log('\nPass A — Stripe subscriptions')
  const best = new Map<string, { sub: Stripe.Subscription; tier: Tier; score: number }>()
  for (const status of ['active', 'trialing', 'past_due'] as const) {
    for await (const sub of stripe.subscriptions.list({
      status,
      limit: 100,
      expand: ['data.customer'],
    })) {
      const tier = await tierForSub(sub)
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      const auth0Sub =
        sub.metadata?.auth0_user_id ??
        (await auth0SubForEmail((await emailForStripeCustomer(sub.customer, stripe)) ?? ''))
      if (!auth0Sub) {
        console.warn(`  ! skip sub ${sub.id} on ${customerId}: no auth0_sub resolvable`)
        continue
      }
      const score = rank(sub, tier)
      const current = best.get(auth0Sub)
      if (!current || score > current.score) best.set(auth0Sub, { sub, tier, score })
    }
  }
  for (const [auth0Sub, { sub, tier }] of best) {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
    const periodEnd = sub.items.data[0]?.current_period_end
    await write(
      {
        auth0_sub: auth0Sub,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        sc_user_id: sub.metadata?.sc_user_id ? Number(sub.metadata.sc_user_id) : null,
        tier,
        status: sub.status,
        plan: (sub.metadata?.plan as string | undefined) ?? null,
        amount_cents: sub.items.data[0]?.price?.unit_amount ?? null,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
      },
      'stripe',
    )
  }

  // --- Pass B: SC members with no Stripe sub (gifts / SC-fed comps) ----------
  console.log('\nPass B — Supporting Cast members without a Stripe subscription')
  let scMembers: ScMembership[] = []
  try {
    scMembers = await loadAllMemberships(createScV1Client(env))
  } catch (err) {
    console.error('  ! SC membership load failed (skipping pass B):', err)
  }
  for (const m of scMembers) {
    if (!m.email) continue
    const auth0Sub = await auth0SubForEmail(m.email)
    if (!auth0Sub || covered.has(auth0Sub)) continue // covered = has a Stripe sub
    await write(
      {
        auth0_sub: auth0Sub,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        sc_user_id: m.user_id ?? null,
        tier: 'ark-plus',
        status: 'active',
        plan: null,
        amount_cents: null,
        current_period_end: null,
        cancel_at: null,
        // Unknown expiry from v1; leave both axes null (perpetual comp grant)
        // rather than risk downgrading a real gift. Flag for manual correction on
        // true gifts.
        ark_plus_gift_expires_at: null,
        circle_gift_expires_at: null,
      },
      'sc-gift/comp',
    )
  }

  // --- Pass C: Auth0 legacy tier-claim comps with no Stripe sub / SC feed -----
  console.log('\nPass C — Auth0 legacy tier-claim comps')
  if (!mgmt) {
    console.log('  (Auth0 management client unavailable — skipping)')
  } else {
    for (let page = 0; page < 20; page += 1) {
      const result = await mgmt.users.list({
        per_page: 100,
        page,
        search_engine: 'v3',
        q: 'app_metadata.tier:"ark-plus-member"',
        fields: 'user_id,email',
        include_fields: true,
        include_totals: true,
      })
      const users = result.data as Array<{ user_id?: string; email?: string }>
      for (const u of users) {
        if (!u.user_id || covered.has(u.user_id)) continue
        auth0SubCache.set((u.email ?? '').toLowerCase(), u.user_id)
        await write(
          {
            auth0_sub: u.user_id,
            stripe_customer_id: null,
            stripe_subscription_id: null,
            sc_user_id: null,
            tier: 'ark-plus',
            status: 'active',
            plan: null,
            amount_cents: null,
            current_period_end: null,
            cancel_at: null,
          },
          'auth0-comp',
        )
      }
      if (users.length < 100) break
    }
  }

  console.log(
    apply
      ? `\nDone. ${written} membership row(s) written/updated.`
      : `\nPreview only — ${written} row(s) would be written. Re-run with --apply.`,
  )
}

main().catch((err) => {
  console.error('[backfill-membership] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
