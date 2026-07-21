// Admin member directory (Option C: Neon is the spine; email is hydrated live
// from Stripe per page, so Neon never stores PII).
//
//   GET /api/admin/members
//     ?email=       exact-match lookup — resolves email → Stripe customer →
//                   membership. When set, pagination is ignored (one result set)
//                   and a customer with no membership row surfaces as tier=free.
//     ?tier=        ark-plus | circle | bundle — SQL filter on the membership spine.
//     ?activation=  activated | unactivated — applied AFTER email hydration.
//                   Activation is keyed by email, not by the membership key, so
//                   it can't be a SQL join; a filtered page can be shorter than
//                   the page size while hasMore still advances the spine.
//     ?offset=      page offset over the (tier-filtered) membership list.
//
// Admin-gated like the rest of the back office. Stripe is required (email source).

import type Stripe from 'stripe'
import { requireAdminRequest } from '../lib/guards.js'
import { getDb } from '../lib/db.js'
import {
  getMembershipsByStripeCustomers,
  listMemberships,
  type MemberDirectoryRow,
} from '../lib/membership.js'
import { getActivatedEmails, normalizeEmail } from '../lib/feed-activations.js'
import type { Tier } from '../entitlement.js'
import { defineRoute } from '../lib/route.js'
import type { Deps, Route } from '../lib/route.js'
import type {
  MemberDirectoryEntry,
  MemberDirectoryPage,
} from '../../shared/member-directory.js'

const PAGE_SIZE = 25

function isTierFilter(v: string | null): v is 'ark-plus' | 'circle' | 'bundle' {
  return v === 'ark-plus' || v === 'circle' || v === 'bundle'
}

// Live vs test dashboard URL is inferred from the secret-key mode.
function stripeCustomerUrl(customerId: string, secretKey: string | undefined): string {
  const test = secretKey?.startsWith('sk_test_') ?? false
  return `https://dashboard.stripe.com/${test ? 'test/' : ''}customers/${customerId}`
}

type StripeCustomerInfo = { email: string | null; name: string | null }

// Retrieve a customer's email/name. A deleted or missing customer resolves to
// nulls rather than throwing, so one bad id can't fail the whole page.
async function retrieveCustomer(
  stripe: Stripe,
  customerId: string,
): Promise<StripeCustomerInfo> {
  try {
    const c = await stripe.customers.retrieve(customerId)
    if ('deleted' in c && c.deleted) return { email: null, name: null }
    const cust = c as Stripe.Customer
    return { email: cust.email ?? null, name: cust.name ?? null }
  } catch {
    return { email: null, name: null }
  }
}

function toEntry(
  row: MemberDirectoryRow,
  info: StripeCustomerInfo,
  activatedEmails: Set<string>,
  secretKey: string | undefined,
): MemberDirectoryEntry {
  return {
    auth0Sub: row.auth0_sub,
    email: info.email,
    name: info.name,
    tier: row.tier,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeCustomerUrl: row.stripe_customer_id
      ? stripeCustomerUrl(row.stripe_customer_id, secretKey)
      : null,
    activated: info.email != null && activatedEmails.has(normalizeEmail(info.email)),
    currentPeriodEnd: row.current_period_end,
    cancelAt: row.cancel_at,
    giftExpiresAt: row.gift_expires_at,
  }
}

export function adminMemberRoutes({ stripe, env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/admin/members',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'not_configured' })

        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const tierParam = params.get('tier')
        if (tierParam !== null && !isTierFilter(tierParam)) {
          return json(400, { error: 'invalid tier filter' })
        }
        const activationParam = params.get('activation')
        if (
          activationParam !== null &&
          activationParam !== 'activated' &&
          activationParam !== 'unactivated'
        ) {
          return json(400, { error: 'invalid activation filter' })
        }
        const emailParam = params.get('email')?.trim() || null

        if (!env.DATABASE_URL) {
          return json(200, { members: [], hasMore: false, nextOffset: null })
        }
        const sql = getDb(env)
        const secretKey = env.STRIPE_SECRET_KEY

        // Applied to already-hydrated entries (email is needed for activation).
        const wantActivated = activationParam === 'activated'
        const matchesActivation = (e: MemberDirectoryEntry) =>
          activationParam === null || e.activated === wantActivated

        // --- Search path: email → Stripe customers → membership -------------
        if (emailParam) {
          const found = await stripe.customers.list({ email: emailParam, limit: 100 })
          const [rowsByCustomer, activatedEmails] = await Promise.all([
            getMembershipsByStripeCustomers(sql, found.data.map((c) => c.id)),
            getActivatedEmails(
              sql,
              found.data.map((c) => c.email).filter((e): e is string => Boolean(e)),
            ),
          ])
          const entries = found.data.map((c): MemberDirectoryEntry => {
            const info: StripeCustomerInfo = { email: c.email ?? null, name: c.name ?? null }
            const row = rowsByCustomer.get(c.id)
            if (row) return toEntry(row, info, activatedEmails, secretKey)
            // Stripe customer with no membership row = not a paying member.
            return {
              auth0Sub: null,
              email: info.email,
              name: info.name,
              tier: 'free',
              status: null,
              stripeCustomerId: c.id,
              stripeCustomerUrl: stripeCustomerUrl(c.id, secretKey),
              activated:
                info.email != null && activatedEmails.has(normalizeEmail(info.email)),
              currentPeriodEnd: null,
              cancelAt: null,
              giftExpiresAt: null,
            }
          })
          const members = entries
            .filter((e) => tierParam === null || e.tier === tierParam)
            .filter(matchesActivation)
          return json(200, {
            members,
            hasMore: false,
            nextOffset: null,
          } satisfies MemberDirectoryPage)
        }

        // --- List path: membership spine, hydrate this page's emails --------
        const offset = Math.max(0, Number(params.get('offset') ?? '0') | 0)
        const rows = await listMemberships(sql, {
          tier: tierParam as Tier | null,
          limit: PAGE_SIZE + 1,
          offset,
        })
        const hasMore = rows.length > PAGE_SIZE
        const pageRows = rows.slice(0, PAGE_SIZE)

        const infos = await Promise.all(
          pageRows.map((r) =>
            r.stripe_customer_id
              ? retrieveCustomer(stripe, r.stripe_customer_id)
              : Promise.resolve<StripeCustomerInfo>({ email: null, name: null }),
          ),
        )
        const activatedEmails = await getActivatedEmails(
          sql,
          infos.map((i) => i.email).filter((e): e is string => Boolean(e)),
        )
        const members = pageRows
          .map((r, i) => toEntry(r, infos[i], activatedEmails, secretKey))
          .filter(matchesActivation) // tier already filtered in SQL
        return json(200, {
          members,
          hasMore,
          nextOffset: hasMore ? offset + PAGE_SIZE : null,
        } satisfies MemberDirectoryPage)
      },
    }),
  ]
}
