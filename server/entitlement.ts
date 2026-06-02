// ---------------------------------------------------------------------------
// Ark Insider — entitlement sync
//
// Source of truth for "is this user a subscriber" lives in Stripe. This module
// pushes that signal out to the systems that need it for gating decisions:
//
//   1. Auth0 — user.app_metadata.tier, surfaced to clients via the
//      AUTH0_TIER_CLAIM custom claim (configured by an Auth0 Login Action).
//   2. Circle — community access group (CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID)
//      controls which Spaces the member can see. Gate Spaces against the
//      group directly in the Circle admin UI.
//
// Failures are isolated per target: if Auth0 is down, Circle still gets
// updated, and vice versa. Both endpoints are idempotent on our end, so the
// nightly reconciliation cron can safely re-run for drift.
//
// Gifts: a gift purchase grants subscriber status for a fixed term without a
// recurring Stripe subscription. The webhook calls syncEntitlement with
// { giftExpiresAt }, which stores the date on Auth0 app_metadata so the
// reconciler does not downgrade the recipient before the gift expires.
//
// Auth0 Action setup (one-time, in the Auth0 dashboard). The namespace in
// the Action code MUST match AUTH0_CLAIM_NAMESPACE in shared/auth0-claims.ts.
//   Actions → Library → Build Custom → name "Add tier claim" →
//   Trigger: Login / Post Login → paste the code below → Deploy →
//   Actions → Flows → Login → drag the Action into the flow → Apply.
//
//     exports.onExecutePostLogin = async (event, api) => {
//       const NS = 'https://ark-plus.xyz'; // matches AUTH0_CLAIM_NAMESPACE
//       const tier = event.user.app_metadata?.tier ?? 'free';
//       api.accessToken.setCustomClaim(`${NS}/tier`, tier);
//       api.idToken.setCustomClaim(`${NS}/tier`, tier);
//     };
// ---------------------------------------------------------------------------

import { gunzipSync } from 'node:zlib'
import type { ManagementClient } from 'auth0'
import type Stripe from 'stripe'
import { getManagementClient } from './auth0.js'
import { downgradeToFree as beehiivDowngradeToFree, tryPush } from './lib/beehiiv-sync.js'
import { getDb } from './lib/db.js'

type Env = Record<string, string>

export type Tier = 'ark-plus-member' | 'free'

export type Auth0Status = 'ok' | 'no-user' | 'skipped' | 'error'
export type CircleStatus = 'ok' | 'no-member' | 'skipped' | 'error'

export type EntitlementResult = {
  email: string
  tier: Tier
  auth0: Auth0Status
  circle: CircleStatus
}

export type SyncOptions = {
  // ISO date string. When set with tier='ark-plus-member', stored in Auth0
  // app_metadata.gift_expires_at so the reconciler keeps the user as a
  // subscriber through the gift period even when no Stripe sub exists.
  // Ignored for tier='free' (which clears the field).
  giftExpiresAt?: string
}

export async function syncEntitlement(
  env: Env,
  email: string,
  tier: Tier,
  opts: SyncOptions = {},
): Promise<EntitlementResult> {
  const [auth0Res, circleRes] = await Promise.allSettled([
    setAuth0Tier(env, email, tier, opts),
    setCircleAccessGroup(env, email, tier),
  ])

  const auth0: Auth0Status =
    auth0Res.status === 'fulfilled'
      ? auth0Res.value
      : logAndReturnError('auth0', email, auth0Res.reason)
  const circle: CircleStatus =
    circleRes.status === 'fulfilled'
      ? circleRes.value
      : logAndReturnError('circle', email, circleRes.reason)
  return { email, tier, auth0, circle }
}

function logAndReturnError(
  label: 'auth0' | 'circle',
  email: string,
  reason: unknown,
): 'error' {
  console.error(`[entitlement] ${label} sync failed for ${redactEmail(email)}:`, reason)
  return 'error'
}

export function redactEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 2) return '***'
  return `${email[0]}***${email.slice(at)}`
}

// --- Auth0 -----------------------------------------------------------------

async function setAuth0Tier(
  env: Env,
  email: string,
  tier: Tier,
  opts: SyncOptions,
): Promise<'ok' | 'no-user' | 'skipped'> {
  if (!env.AUTH0_MANAGEMENT_CLIENT_ID || !env.AUTH0_MANAGEMENT_CLIENT_SECRET) {
    return 'skipped'
  }
  const mgmt = getManagementClient(env)
  if (!mgmt) throw new Error('Auth0 mgmt client unavailable')

  const users = await mgmt.users.listUsersByEmail({ email })
  if (users.length === 0) return 'no-user'

  // app_metadata PATCH is a shallow merge: keys we omit are preserved on the
  // user, so we explicitly null gift_expires_at on downgrade to clear it.
  const appMetadata: Record<string, unknown> = { tier }
  if (tier === 'ark-plus-member' && opts.giftExpiresAt) {
    appMetadata.gift_expires_at = opts.giftExpiresAt
  } else if (tier === 'free') {
    appMetadata.gift_expires_at = null
  }

  // Same email can exist in multiple connections (e.g. Username-Password
  // and a social provider). Patch all so any session the user starts gets
  // the right tier. Any one rejecting rejects the whole batch → 'error'.
  await Promise.all(
    users.map((u) =>
      u.user_id
        ? mgmt.users.update(u.user_id, { app_metadata: appMetadata })
        : Promise.resolve(),
    ),
  )
  return 'ok'
}

// Server-side helper for the Circle SSO route: look up the tier directly when
// the JWT claim is missing (e.g. the Auth0 Action hasn't been deployed yet,
// or the access token predates the Action). Returns null on any failure so
// the caller can fall back to a safe default.
export async function fetchAuth0TierForEmail(
  env: Env,
  email: string,
): Promise<Tier | null> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return null
  let users: Array<{ app_metadata?: { tier?: string } }>
  try {
    users = await mgmt.users.listUsersByEmail({
      email,
      fields: 'app_metadata',
      include_fields: true,
    })
  } catch {
    return null
  }
  for (const u of users) {
    if (u.app_metadata?.tier === 'ark-plus-member') return 'ark-plus-member'
  }
  return users.length > 0 ? 'free' : null
}

// Used by the Circle SSO route to gate access on email verification. Returns
// true only if Auth0 has at least one identity for this email with
// email_verified=true. Returns null on any lookup failure so callers can
// decide whether to fail open or closed.
export async function fetchAuth0EmailVerified(
  env: Env,
  email: string,
): Promise<boolean | null> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return null
  let users: Array<{ email_verified?: boolean }>
  try {
    users = await mgmt.users.listUsersByEmail({
      email,
      fields: 'email_verified',
      include_fields: true,
    })
  } catch {
    return null
  }
  if (users.length === 0) return null
  return users.some((u) => u.email_verified === true)
}

// --- Circle ----------------------------------------------------------------
// Circle's Admin v2 API. Members of the configured access group can see the
// Spaces gated to it; non-members can't. The group's ID is created once in
// Circle admin and stored as CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID.
//
// The Admin v2 access-groups endpoints take email directly, so no separate
// member-id lookup is needed in the per-email path. Member-id resolution is
// still required for the reconciler's drift pass (see
// listCircleAccessGroupSubscriberEmails) because the access-group list
// returns only ids.

const CIRCLE_API = 'https://app.circle.so/api/admin/v2'

async function setCircleAccessGroup(
  env: Env,
  email: string,
  tier: Tier,
): Promise<'ok' | 'no-member' | 'skipped'> {
  const apiToken = env.CIRCLE_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return 'skipped'

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }
  const base = `${CIRCLE_API}/access_groups/${encodeURIComponent(accessGroupId)}/community_members`

  if (tier === 'ark-plus-member') {
    const res = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email }),
    })
    // 404 → the email isn't a Circle community member yet. Treat as
    // no-member, matching the pre-access-group behavior; the user will be
    // added on their first Circle SSO.
    if (res.status === 404) return 'no-member'
    // 422 / 409 → already a member (Circle's response code for duplicates is
    // undocumented in the Admin v2 spec; both have been observed in practice).
    // Treat as in-desired-state. All other 4xx (400, 401, 403, ...) still
    // throw so auth and validation errors surface.
    if (!res.ok && res.status !== 422 && res.status !== 409) {
      throw new Error(`Circle access-group POST ${res.status}: ${await res.text()}`)
    }
    return 'ok'
  }

  // tier === 'free' → remove
  const res = await fetch(
    `${base}?email=${encodeURIComponent(email)}`,
    { method: 'DELETE', headers },
  )
  // 404 → not in the group already (either never was, or no member record).
  // Treat as desired state.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Circle access-group DELETE ${res.status}: ${await res.text()}`)
  }
  return 'ok'
}

// --- Stripe customer → email ------------------------------------------------

export async function emailForStripeCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  stripe: Stripe,
): Promise<string | null> {
  if (!customer) return null
  if (typeof customer === 'object') {
    if ('deleted' in customer && customer.deleted) return null
    return customer.email ?? null
  }
  const c = await stripe.customers.retrieve(customer)
  if (c.deleted) return null
  return c.email ?? null
}

// --- Reconciliation ---------------------------------------------------------
// Three passes:
//   1. Walk Stripe active+trialing subs, sync each to 'ark-plus-member'. This
//      heals any missed webhook upgrades.
//   2. Walk Auth0 users with tier='ark-plus-member'. For any whose email is not
//      in the active set AND whose gift hasn't expired, leave alone. The
//      rest get synced to 'free'. This heals any missed webhook downgrades.
//   3. Walk Circle's subscriber access group. Remove any members who aren't
//      in the active set, aren't gift-protected, and weren't already
//      touched by pass 2. Catches drift where Auth0 already reads 'free'
//      but Circle still has the user in the access group — pass 2 misses
//      those because it iterates Auth0, not Circle.
//
// Auth0 v3 search caps at 1000 hits regardless of pagination; pass 2 falls
// back to /jobs/users-exports when that ceiling is reached.
//
// Circle drift removals are capped (CIRCLE_DRIFT_MAX_REMOVE) so a bad list
// response can't mass-downgrade subscribers — any overflow waits for the
// next cron run.

type ReconcileSummary = {
  scanned: number
  upgraded: number
  downgraded: number
  errors: number
  results: EntitlementResult[]
}

const CIRCLE_DRIFT_MAX_REMOVE = 100

export async function reconcileEntitlements(
  env: Env,
  stripe: Stripe,
  opts: { maxStripePages?: number; maxAuth0Pages?: number; batchSize?: number } = {},
): Promise<ReconcileSummary> {
  const maxStripePages = opts.maxStripePages ?? 10
  const maxAuth0Pages = opts.maxAuth0Pages ?? 10
  const batchSize = opts.batchSize ?? 8

  const activeEmails = await collectActiveStripeEmails(stripe, maxStripePages)

  const upgradeResults = await batched(
    [...activeEmails],
    batchSize,
    (email) => syncEntitlement(env, email, 'ark-plus-member'),
  )

  const auth0Subs = await listAuth0Subscribers(env, maxAuth0Pages)
  const now = Date.now()
  const giftProtected = new Set(
    auth0Subs
      .filter((u) => u.gift_expires_at && Date.parse(u.gift_expires_at) > now)
      .map((u) => u.email),
  )
  const downgradeEmails = auth0Subs
    .filter((u) => !activeEmails.has(u.email) && !giftProtected.has(u.email))
    .map((u) => u.email)

  const downgradeResults = await batched(
    downgradeEmails,
    batchSize,
    (email) => syncEntitlement(env, email, 'free'),
  )

  // Beehiiv: drop premium tier from the same set of emails. Soft-fail per
  // address so a Beehiiv outage doesn't poison the reconciler summary.
  if (env.DATABASE_URL && downgradeEmails.length > 0) {
    const sql = getDb(env)
    await batched(downgradeEmails, batchSize, (email) =>
      tryPush('reconcile downgrade', () => beehiivDowngradeToFree({ env, sql }, email)),
    )
  }

  // Pass 3 — Circle drift. Soft-fail: a list error shouldn't fail the cron.
  const downgradeSet = new Set(downgradeEmails)
  const circleSubs = await listCircleAccessGroupSubscriberEmails(
    env,
    maxAuth0Pages,
  ).catch((err: unknown) => {
    console.error('[reconcile] listCircleAccessGroupSubscriberEmails failed:', err)
    return [] as string[]
  })
  const driftEmails = circleSubs
    .filter(
      (email) =>
        !activeEmails.has(email) &&
        !giftProtected.has(email) &&
        !downgradeSet.has(email),
    )
    .slice(0, CIRCLE_DRIFT_MAX_REMOVE)

  const driftResults = await batched(
    driftEmails,
    batchSize,
    (email) => syncEntitlement(env, email, 'free'),
  )

  const results = [...upgradeResults, ...downgradeResults, ...driftResults]
  return {
    scanned: results.length,
    upgraded: activeEmails.size,
    downgraded: downgradeEmails.length + driftEmails.length,
    errors: results.filter((r) => r.auth0 === 'error' || r.circle === 'error').length,
    results,
  }
}

export async function collectActiveStripeEmails(
  stripe: Stripe,
  maxPages: number,
): Promise<Set<string>> {
  const emails = new Set<string>()
  for (const status of ['active', 'trialing'] as const) {
    let starting_after: string | undefined
    let pages = 0
    while (pages < maxPages) {
      const page = await stripe.subscriptions.list({
        status,
        limit: 100,
        expand: ['data.customer'],
        ...(starting_after ? { starting_after } : {}),
      })
      for (const sub of page.data) {
        const email = await emailForStripeCustomer(sub.customer, stripe)
        if (email) emails.add(email.toLowerCase())
      }
      if (!page.has_more) break
      starting_after = page.data[page.data.length - 1]?.id
      pages += 1
    }
  }
  return emails
}

type Auth0SubscriberRow = { email: string; gift_expires_at?: string }

async function listAuth0Subscribers(
  env: Env,
  maxPages: number,
): Promise<Auth0SubscriberRow[]> {
  const mgmt = getManagementClient(env)
  if (!mgmt) return []
  const out: Auth0SubscriberRow[] = []
  // include_totals so the SDK's paginated response carries a `users` array
  // (a bare-array response has no items the Page wrapper can extract). Pass `q`
  // raw — the SDK encodes query params itself.
  let lastPageFull = false
  let pagesWalked = 0
  for (let page = 0; page < maxPages; page += 1) {
    const result = await mgmt.users.list({
      per_page: 100,
      page,
      search_engine: 'v3',
      q: 'app_metadata.tier:"ark-plus-member"',
      fields: 'email,app_metadata',
      include_fields: true,
      include_totals: true,
    })
    const users = result.data as Array<{
      email?: string
      app_metadata?: { gift_expires_at?: string }
    }>
    for (const u of users) {
      if (!u.email) continue
      out.push({
        email: u.email.toLowerCase(),
        gift_expires_at: u.app_metadata?.gift_expires_at,
      })
    }
    pagesWalked = page + 1
    lastPageFull = users.length === 100
    if (!lastPageFull) break
  }

  // Auth0 v3 search caps at 1000 results regardless of pagination. If we
  // walked the full budget and the last page came back full, more users
  // likely exist beyond the cap — switch to the export job.
  if (lastPageFull && pagesWalked === maxPages) {
    console.warn(
      '[auth0] subscriber list hit search cap after',
      pagesWalked,
      'pages; falling back to export job',
    )
    return listAuth0SubscribersViaExport(mgmt)
  }
  return out
}

// Export-job fallback. POSTs /jobs/users-exports, polls the job to
// completion, then downloads the signed result URL (gzipped NDJSON) and
// projects subscribers down to Auth0SubscriberRow. Slower than the search
// endpoint (Auth0 takes seconds to tens of seconds) but uncapped.
const AUTH0_EXPORT_MAX_WAIT_MS = 90_000
const AUTH0_EXPORT_INITIAL_POLL_MS = 2_000
const AUTH0_EXPORT_MAX_POLL_MS = 10_000

async function listAuth0SubscribersViaExport(
  mgmt: ManagementClient,
): Promise<Auth0SubscriberRow[]> {
  const job = await mgmt.jobs.usersExports.create({
    format: 'json',
    fields: [
      { name: 'email' },
      { name: 'app_metadata.tier' },
      { name: 'app_metadata.gift_expires_at' },
    ],
  })
  if (!job.id) throw new Error('Auth0 export create returned no job id')
  const jobId = job.id

  // Poll with exponential backoff up to AUTH0_EXPORT_MAX_WAIT_MS.
  const start = Date.now()
  let waitMs = AUTH0_EXPORT_INITIAL_POLL_MS
  let location: string | null = null
  while (Date.now() - start < AUTH0_EXPORT_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, waitMs))
    const status = await mgmt.jobs.get(jobId)
    if (status.status === 'completed') {
      if (!status.location) {
        throw new Error('Auth0 export completed without a location URL')
      }
      location = status.location
      break
    }
    if (status.status === 'failed') {
      throw new Error(`Auth0 export job failed: ${JSON.stringify(status)}`)
    }
    waitMs = Math.min(Math.floor(waitMs * 1.5), AUTH0_EXPORT_MAX_POLL_MS)
  }
  if (!location) {
    throw new Error(
      `Auth0 export timed out after ${AUTH0_EXPORT_MAX_WAIT_MS}ms`,
    )
  }

  // Signed result URL — Auth0 sets it on the job. The body is gzip-compressed
  // NDJSON (one JSON object per line). No auth on this URL — it's pre-signed.
  const downloadRes = await fetch(location)
  if (!downloadRes.ok) {
    throw new Error(`Auth0 export download ${downloadRes.status}`)
  }
  const buf = Buffer.from(await downloadRes.arrayBuffer())
  const text = gunzipSync(buf).toString('utf8')

  const out: Auth0SubscriberRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: {
      email?: string
      app_metadata?: { tier?: string; gift_expires_at?: string }
    }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.app_metadata?.tier !== 'ark-plus-member') continue
    if (!row.email) continue
    out.push({
      email: row.email.toLowerCase(),
      gift_expires_at: row.app_metadata.gift_expires_at,
    })
  }
  return out
}

// Lists emails of members currently in the subscriber access group. Used by
// the reconciler's drift pass to catch the case where Circle still has the
// member in the group but Auth0 already reads 'free' (a partial-failure
// during a downgrade webhook).
//
// The Admin v2 access-group list endpoint returns only community_member_id;
// we resolve those to emails by walking /community_members in parallel and
// joining the two. Both walks share the same maxPages budget.
async function listCircleAccessGroupSubscriberEmails(
  env: Env,
  maxPages: number,
): Promise<string[]> {
  const apiToken = env.CIRCLE_API_TOKEN
  const accessGroupId = env.CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID
  if (!apiToken || !accessGroupId) return []

  const headers = { Authorization: `Bearer ${apiToken}` }

  // 1. Member ids in the access group.
  const memberIds = new Set<number>()
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      `${CIRCLE_API}/access_groups/${encodeURIComponent(accessGroupId)}/community_members` +
      `?per_page=100&page=${page}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      throw new Error(`Circle access-group list ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as {
      records?: Array<{ community_member_id?: number }>
      has_next_page?: boolean
    }
    const records = body.records ?? []
    for (const r of records) {
      if (typeof r.community_member_id === 'number') memberIds.add(r.community_member_id)
    }
    if (records.length < 100 || body.has_next_page === false) break
  }
  if (memberIds.size === 0) return []

  // 2. Resolve ids → emails by walking the full members list.
  const emails: string[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${CIRCLE_API}/community_members?per_page=100&page=${page}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      throw new Error(`Circle members list ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as {
      records?: Array<{ id?: number; email?: string }>
      has_next_page?: boolean
    }
    const records = body.records ?? []
    for (const r of records) {
      if (
        typeof r.id === 'number' &&
        memberIds.has(r.id) &&
        typeof r.email === 'string'
      ) {
        emails.push(r.email.toLowerCase())
      }
    }
    // Once every id in the access group has been matched, no need to keep paging.
    if (emails.length >= memberIds.size) break
    if (records.length < 100 || body.has_next_page === false) break
  }
  return emails
}

async function batched<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    const res = await Promise.all(chunk.map(fn))
    out.push(...res)
  }
  return out
}
