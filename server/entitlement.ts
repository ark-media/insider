// ---------------------------------------------------------------------------
// Ark Insider — entitlement sync
//
// Source of truth for "is this user a subscriber" lives in Stripe. This module
// pushes that signal out to the systems that need it for gating decisions:
//
//   1. Auth0 — user.app_metadata.tier, surfaced to clients via the
//      AUTH0_TIER_CLAIM custom claim (configured by an Auth0 Login Action).
//   2. Circle — community member tag (CIRCLE_SUBSCRIBER_TAG_ID) controls
//      which Spaces the member can see.
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
import type Stripe from 'stripe'
import { auth0MgmtBase, getAuth0ManagementToken } from './auth0.js'

type Env = Record<string, string>

export type Tier = 'subscriber' | 'free'

export type Auth0Status = 'ok' | 'no-user' | 'skipped' | 'error'
export type CircleStatus = 'ok' | 'no-member' | 'skipped' | 'error'

export type EntitlementResult = {
  email: string
  tier: Tier
  auth0: Auth0Status
  circle: CircleStatus
}

export type SyncOptions = {
  // ISO date string. When set with tier='subscriber', stored in Auth0
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
    setCircleTag(env, email, tier),
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

function redactEmail(email: string): string {
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
  const token = await getAuth0ManagementToken(env)
  if (!token) throw new Error('Auth0 mgmt token unavailable')

  const base = auth0MgmtBase(env)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const lookup = await fetch(
    `${base}/users-by-email?email=${encodeURIComponent(email)}`,
    { headers },
  )
  if (!lookup.ok) {
    throw new Error(`Auth0 lookup ${lookup.status}: ${await lookup.text()}`)
  }
  const users = (await lookup.json()) as Array<{ user_id: string }>
  if (users.length === 0) return 'no-user'

  // app_metadata PATCH is a shallow merge: keys we omit are preserved on the
  // user, so we explicitly null gift_expires_at on downgrade to clear it.
  const appMetadata: Record<string, unknown> = { tier }
  if (tier === 'subscriber' && opts.giftExpiresAt) {
    appMetadata.gift_expires_at = opts.giftExpiresAt
  } else if (tier === 'free') {
    appMetadata.gift_expires_at = null
  }

  // Same email can exist in multiple connections (e.g. Username-Password
  // and a social provider). Patch all so any session the user starts gets
  // the right tier.
  await Promise.all(
    users.map(async (u) => {
      const patch = await fetch(
        `${base}/users/${encodeURIComponent(u.user_id)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ app_metadata: appMetadata }),
        },
      )
      if (!patch.ok) {
        throw new Error(`Auth0 patch ${patch.status}: ${await patch.text()}`)
      }
    }),
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
  if (!env.AUTH0_MANAGEMENT_CLIENT_ID || !env.AUTH0_MANAGEMENT_CLIENT_SECRET) return null
  const token = await getAuth0ManagementToken(env)
  if (!token) return null
  const base = auth0MgmtBase(env)
  const res = await fetch(
    `${base}/users-by-email?email=${encodeURIComponent(email)}&fields=app_metadata&include_fields=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return null
  const users = (await res.json()) as Array<{ app_metadata?: { tier?: string } }>
  for (const u of users) {
    if (u.app_metadata?.tier === 'subscriber') return 'subscriber'
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
  if (!env.AUTH0_MANAGEMENT_CLIENT_ID || !env.AUTH0_MANAGEMENT_CLIENT_SECRET) return null
  const token = await getAuth0ManagementToken(env)
  if (!token) return null
  const base = auth0MgmtBase(env)
  const res = await fetch(
    `${base}/users-by-email?email=${encodeURIComponent(email)}&fields=email_verified&include_fields=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return null
  const users = (await res.json()) as Array<{ email_verified?: boolean }>
  if (users.length === 0) return null
  return users.some((u) => u.email_verified === true)
}

// --- Circle ----------------------------------------------------------------
// Circle's Headless Member API (v1). Find a member by email, then add or
// remove the subscriber tag. The tag's ID is created once in the Circle admin
// UI and stored as CIRCLE_SUBSCRIBER_TAG_ID.

const CIRCLE_API = 'https://app.circle.so/api/v1'

async function setCircleTag(
  env: Env,
  email: string,
  tier: Tier,
): Promise<'ok' | 'no-member' | 'skipped'> {
  const apiToken = env.CIRCLE_API_TOKEN
  const communityId = env.CIRCLE_COMMUNITY_ID
  const tagId = env.CIRCLE_SUBSCRIBER_TAG_ID
  if (!apiToken || !communityId || !tagId) return 'skipped'

  const headers = { Authorization: `Token ${apiToken}` }

  const find = await fetch(
    `${CIRCLE_API}/community_members/search?email=${encodeURIComponent(email)}&community_id=${encodeURIComponent(communityId)}`,
    { headers },
  )
  if (find.status === 404) return 'no-member'
  if (!find.ok) {
    throw new Error(`Circle search ${find.status}: ${await find.text()}`)
  }
  const member = (await find.json()) as { id?: number } | null
  if (!member?.id) return 'no-member'

  const method = tier === 'subscriber' ? 'POST' : 'DELETE'
  const tagRes = await fetch(
    `${CIRCLE_API}/community_members/${member.id}/tags/${encodeURIComponent(tagId)}`,
    { method, headers },
  )
  // DELETE on a tag the member doesn't have, and POST on a tag they already
  // have, both return 4xx. Treat those as already-in-desired-state.
  if (!tagRes.ok && tagRes.status !== 404 && tagRes.status !== 422) {
    throw new Error(`Circle tag ${method} ${tagRes.status}: ${await tagRes.text()}`)
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
//   1. Walk Stripe active+trialing subs, sync each to 'subscriber'. This
//      heals any missed webhook upgrades.
//   2. Walk Auth0 users with tier='subscriber'. For any whose email is not
//      in the active set AND whose gift hasn't expired, leave alone. The
//      rest get synced to 'free'. This heals any missed webhook downgrades.
//   3. Walk Circle members with the subscriber tag. Untag any that aren't in
//      the active set, aren't gift-protected, and weren't already touched by
//      pass 2. Catches drift where Auth0 already reads 'free' but Circle
//      still has the tag — pass 2 misses those because it iterates Auth0,
//      not Circle.
//
// Auth0 v3 search caps at 1000 hits regardless of pagination; pass 2 falls
// back to /jobs/users-exports when that ceiling is reached.
//
// Circle drift untags are capped (CIRCLE_DRIFT_MAX_UNTAG) so a bad list
// response can't mass-downgrade subscribers — any overflow waits for the
// next cron run.

type ReconcileSummary = {
  scanned: number
  upgraded: number
  downgraded: number
  errors: number
  results: EntitlementResult[]
}

const CIRCLE_DRIFT_MAX_UNTAG = 100

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
    (email) => syncEntitlement(env, email, 'subscriber'),
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

  // Pass 3 — Circle drift. Soft-fail: a list error shouldn't fail the cron.
  const downgradeSet = new Set(downgradeEmails)
  const circleSubs = await listCircleSubscribers(env, maxAuth0Pages).catch(
    (err: unknown) => {
      console.error('[reconcile] listCircleSubscribers failed:', err)
      return [] as string[]
    },
  )
  const driftEmails = circleSubs
    .filter(
      (email) =>
        !activeEmails.has(email) &&
        !giftProtected.has(email) &&
        !downgradeSet.has(email),
    )
    .slice(0, CIRCLE_DRIFT_MAX_UNTAG)

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

async function collectActiveStripeEmails(
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
  if (!env.AUTH0_MANAGEMENT_CLIENT_ID || !env.AUTH0_MANAGEMENT_CLIENT_SECRET) return []
  const token = await getAuth0ManagementToken(env)
  if (!token) return []
  const base = auth0MgmtBase(env)
  const headers = { Authorization: `Bearer ${token}` }
  const out: Auth0SubscriberRow[] = []
  const query = encodeURIComponent('app_metadata.tier:"subscriber"')
  let lastPageFull = false
  let pagesWalked = 0
  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `${base}/users?per_page=100&page=${page}` +
      `&search_engine=v3&q=${query}` +
      `&fields=email,app_metadata&include_fields=true`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      throw new Error(`Auth0 list ${res.status}: ${await res.text()}`)
    }
    const users = (await res.json()) as Array<{
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
    return listAuth0SubscribersViaExport(env, token)
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
  env: Env,
  mgmtToken: string,
): Promise<Auth0SubscriberRow[]> {
  const base = auth0MgmtBase(env)
  const authHeaders = { Authorization: `Bearer ${mgmtToken}` }

  const createRes = await fetch(`${base}/jobs/users-exports`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      format: 'json',
      fields: [
        { name: 'email' },
        { name: 'app_metadata.tier' },
        { name: 'app_metadata.gift_expires_at' },
      ],
    }),
  })
  if (!createRes.ok) {
    throw new Error(
      `Auth0 export create ${createRes.status}: ${await createRes.text()}`,
    )
  }
  const job = (await createRes.json()) as { id?: string }
  if (!job.id) throw new Error('Auth0 export create returned no job id')

  // Poll with exponential backoff up to AUTH0_EXPORT_MAX_WAIT_MS.
  const start = Date.now()
  let waitMs = AUTH0_EXPORT_INITIAL_POLL_MS
  let location: string | null = null
  while (Date.now() - start < AUTH0_EXPORT_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, waitMs))
    const statusRes = await fetch(
      `${base}/jobs/${encodeURIComponent(job.id)}`,
      { headers: authHeaders },
    )
    if (!statusRes.ok) {
      throw new Error(
        `Auth0 export status ${statusRes.status}: ${await statusRes.text()}`,
      )
    }
    const status = (await statusRes.json()) as {
      status?: string
      location?: string
    }
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
    if (row.app_metadata?.tier !== 'subscriber') continue
    if (!row.email) continue
    out.push({
      email: row.email.toLowerCase(),
      gift_expires_at: row.app_metadata.gift_expires_at,
    })
  }
  return out
}

// Lists Circle community members tagged as subscribers. Used by the
// reconciler's drift pass to catch the case where Circle still has the
// subscriber tag but Auth0 already reads 'free' (a partial-failure during a
// downgrade webhook). Returns emails lowercased.
async function listCircleSubscribers(
  env: Env,
  maxPages: number,
): Promise<string[]> {
  const apiToken = env.CIRCLE_API_TOKEN
  const communityId = env.CIRCLE_COMMUNITY_ID
  const tagId = env.CIRCLE_SUBSCRIBER_TAG_ID
  if (!apiToken || !communityId || !tagId) return []

  const headers = { Authorization: `Token ${apiToken}` }
  const emails: string[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      `${CIRCLE_API}/community_members?` +
      `community_id=${encodeURIComponent(communityId)}` +
      `&per_page=100&page=${page}` +
      `&member_tag_ids[]=${encodeURIComponent(tagId)}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      throw new Error(`Circle list ${res.status}: ${await res.text()}`)
    }
    // Circle's v1 list returns either a bare array or an envelope; accept both.
    const body = (await res.json()) as
      | Array<{ email?: string }>
      | { records?: Array<{ email?: string }> }
    const records = Array.isArray(body) ? body : (body.records ?? [])
    for (const r of records) {
      if (r.email) emails.push(r.email.toLowerCase())
    }
    if (records.length < 100) break
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
