// ---------------------------------------------------------------------------
// Ark Insider — API plugin
//
// Backend for the marketing site, run as Vite middleware in dev and as a
// single Vercel Node Function (`api/[...slug].ts`) in production. Handles
// Supporting Cast (SC) user/feed lookup, Stripe checkout + gifting, and the
// SC ↔ Stripe glue via webhooks.
//
// Auth: long-term sessions are Auth0 Bearer tokens; new subscribers get a
// short-lived HS256 `ark_checkout` JWT cookie so they can complete /setup
// before clicking the password-reset email. See `getSessionEmail`.
// ---------------------------------------------------------------------------

import type { Plugin, Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import crypto from 'node:crypto'
import Stripe from 'stripe'
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose'
import {
  isPublishedEpisode,
  projectScEpisode,
  type ProjectedEpisode,
  type ScEpisode,
} from './show-notes.js'

const AUTH0_DOMAIN = 'https://auth.ark-plus.xyz'
const AUTH0_AUDIENCE = 'https://ark-plus.xyz/api'
const EMAIL_CLAIM = 'https://ark-plus.xyz/email'
const AUTH0_CLIENT_ID = '1T1u9VRHbSWxOwy8OX5PVYw9BdPNtAvp'

// Checkout-session tokens are HS256 JWTs we issue ourselves to log a new
// subscriber in immediately after payment, without forcing them to click a
// password-reset email first. The TTL is short — it only needs to cover
// landing on /setup and finishing onboarding. After it expires the user logs
// in normally via Auth0 with the password they set from the reset email.
//
// The token rides in an httpOnly cookie so JS — including any XSS payload —
// can't exfiltrate it. A second non-httpOnly companion cookie ("present")
// gives the SPA a way to detect that a session exists without exposing the
// token itself.
const CHECKOUT_TOKEN_ISSUER = 'ark-insider'
const CHECKOUT_TOKEN_AUDIENCE = 'checkout-session'
const CHECKOUT_TOKEN_TTL_SEC = 30 * 60
const CHECKOUT_COOKIE_NAME = 'ark_checkout'
const CHECKOUT_PRESENT_COOKIE_NAME = 'ark_checkout_present'

function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim()
    }
  }
  return null
}

function buildCookie(
  name: string,
  value: string,
  opts: { maxAgeSec: number; httpOnly: boolean; secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSec}`,
  ]
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

function isSecureOrigin(env: Env): boolean {
  return env.APP_BASE_URL?.startsWith('https://') ?? false
}

function setCheckoutCookies(res: ServerResponse, token: string, env: Env): void {
  const secure = isSecureOrigin(env)
  res.setHeader('Set-Cookie', [
    buildCookie(CHECKOUT_COOKIE_NAME, token, {
      maxAgeSec: CHECKOUT_TOKEN_TTL_SEC,
      httpOnly: true,
      secure,
    }),
    buildCookie(CHECKOUT_PRESENT_COOKIE_NAME, '1', {
      maxAgeSec: CHECKOUT_TOKEN_TTL_SEC,
      httpOnly: false,
      secure,
    }),
  ])
}

function clearCheckoutCookies(res: ServerResponse, env: Env): void {
  const secure = isSecureOrigin(env)
  res.setHeader('Set-Cookie', [
    buildCookie(CHECKOUT_COOKIE_NAME, '', { maxAgeSec: 0, httpOnly: true, secure }),
    buildCookie(CHECKOUT_PRESENT_COOKIE_NAME, '', { maxAgeSec: 0, httpOnly: false, secure }),
  ])
}

const jwks = createRemoteJWKSet(new URL(`${AUTH0_DOMAIN}/.well-known/jwks.json`))

async function verifyAuth0Bearer(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${AUTH0_DOMAIN}/`,
      audience: AUTH0_AUDIENCE,
    })
    return (payload[EMAIL_CLAIM] as string | undefined) ?? null
  } catch {
    return null
  }
}

async function verifyCheckoutToken(token: string, env: Env): Promise<string | null> {
  const secret = env.CHECKOUT_SESSION_SECRET
  if (!secret) return null
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: CHECKOUT_TOKEN_ISSUER,
      audience: CHECKOUT_TOKEN_AUDIENCE,
    })
    return (payload.email as string | undefined) ?? null
  } catch {
    return null
  }
}

async function signCheckoutToken(email: string, env: Env): Promise<string> {
  const secret = env.CHECKOUT_SESSION_SECRET
  if (!secret) throw new Error('CHECKOUT_SESSION_SECRET not configured')
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(CHECKOUT_TOKEN_ISSUER)
    .setAudience(CHECKOUT_TOKEN_AUDIENCE)
    .setExpirationTime(`${CHECKOUT_TOKEN_TTL_SEC}s`)
    .sign(new TextEncoder().encode(secret))
}

async function getSessionEmail(
  req: IncomingMessage,
  env: Env,
): Promise<string | null> {
  // Auth0 sessions arrive as Bearer tokens; the post-checkout session rides
  // in an httpOnly cookie. Prefer Bearer (the authoritative long-term session
  // once the user has finished password setup) and fall back to the cookie.
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const email =
      (await verifyAuth0Bearer(token)) ?? (await verifyCheckoutToken(token, env))
    if (email) return email
  }
  const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
  if (cookieToken) return verifyCheckoutToken(cookieToken, env)
  return null
}
type Env = Record<string, string>

type ScError = Error & { status?: number; data?: unknown }

type ScUser = {
  id: number
  email: string
  first_name?: string
  last_name?: string
}

type ScUserFeed = {
  id: number
  name: string
  url: string
  description?: string
  image_url?: string
  apps?: Array<{ app: string; name: string; url: string }>
}

// Gifting — one-time Stripe charge, fixed-term SC subscription with ends_at.
type GiftTerm = '6mo' | '1yr'

type GiftMetadata = {
  giverEmail: string
  giverName?: string
  orderId: string          // Stripe PaymentIntent id
  term: GiftTerm
  purchasedAt: string      // ISO date
  message?: string
}

const GIFT_PRICES_CENTS: Record<GiftTerm, number> = { '6mo': 4800, '1yr': 8000 }
const GIFT_TERM_DAYS: Record<GiftTerm, number> = { '6mo': 182, '1yr': 365 }


// ---------------------------------------------------------------------------
// Supporting Cast client
// ---------------------------------------------------------------------------
function createScClient(env: Env) {
  const networkId = env.SC_NETWORK_ID
  const apiKey = env.SC_API_KEY
  if (!networkId || !apiKey) {
    throw new Error('SC_NETWORK_ID and SC_API_KEY must be set in .env')
  }
  const base = `https://api.supportingcast.fm/v2/${networkId}`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const call = async <T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    const data = text ? (JSON.parse(text) as unknown) : null
    if (!r.ok) {
      const err: ScError = Object.assign(
        new Error(`SC ${method} ${path} failed: ${r.status}`),
        { status: r.status, data },
      )
      throw err
    }
    return data as T
  }
  return { call }
}

type ScClient = ReturnType<typeof createScClient>

async function findScUserByEmail(sc: ScClient, email: string): Promise<ScUser | null> {
  // `family: 'all'` searches the parent + child networks. Without it, a user
  // that exists on the parent network is invisible here, but POST /users
  // still rejects the email as taken — producing a confusing 422.
  const res = await sc.call<{ users?: ScUser[] }>('POST', '/users/search', {
    email,
    family: 'all',
  })
  return res.users?.[0] ?? null
}

async function findOrCreateScUser(
  sc: ScClient,
  email: string,
  nameHint?: string,
): Promise<ScUser> {
  const existing = await findScUserByEmail(sc, email)
  if (existing) return existing
  const first = (nameHint || email.split('@')[0] || 'Member').slice(0, 40)
  const created = await sc.call<{ user: ScUser }>('POST', '/users', {
    email,
    first_name: first,
    last_name: '',
  })
  return created.user
}

// ---------------------------------------------------------------------------
// Auth0 Management API — create users after successful payment
// ---------------------------------------------------------------------------

type Auth0MgmtToken = { access_token: string; expires_at: number }
// Module-level cache is effective in long-running dev/prod processes but resets
// on each serverless cold start — tokens are re-fetched per invocation there.
let cachedMgmtToken: Auth0MgmtToken | null = null

async function getAuth0ManagementToken(env: Env): Promise<string | null> {
  const clientId = env.AUTH0_MANAGEMENT_CLIENT_ID
  const clientSecret = env.AUTH0_MANAGEMENT_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  if (cachedMgmtToken && cachedMgmtToken.expires_at > Date.now() + 60_000) {
    return cachedMgmtToken.access_token
  }

  // Custom domains don't host the Management API — the audience and token
  // endpoint must use the native Auth0 tenant domain (e.g. foo.us.auth0.com).
  const tenantDomain = env.AUTH0_TENANT_DOMAIN || AUTH0_DOMAIN

  const res = await fetch(`${tenantDomain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `${tenantDomain}/api/v2/`,
    }),
  })
  if (!res.ok) {

    console.error('[auth0] mgmt token failed:', res.status, await res.text())
    return null
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedMgmtToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }
  return data.access_token
}

async function findOrCreateAuth0User(
  email: string,
  nameHint: string | undefined,
  env: Env,
): Promise<string | null> {
  const token = await getAuth0ManagementToken(env)
  if (!token) return null

  const tenantDomain = env.AUTH0_TENANT_DOMAIN || AUTH0_DOMAIN
  const base = `${tenantDomain}/api/v2`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // Return early if Auth0 user already exists.
  const searchRes = await fetch(
    `${base}/users-by-email?email=${encodeURIComponent(email)}`,
    { headers },
  )
  if (searchRes.ok) {
    const existing = (await searchRes.json()) as Array<{ user_id: string }>
    if (existing.length > 0) return existing[0].user_id
  }

  // Create Auth0 user with a random temporary password — the password-change
  // email below is how they'll actually log in for the first time.
  const spaceIdx = (nameHint ?? '').indexOf(' ')
  const givenName = spaceIdx > -1 ? nameHint!.slice(0, spaceIdx) : (nameHint ?? '')
  const familyName = spaceIdx > -1 ? nameHint!.slice(spaceIdx + 1) : ''
  const tempPassword = `Tmp-${crypto.randomBytes(16).toString('hex')}`

  const createRes = await fetch(`${base}/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      connection: 'Username-Password-Authentication',
      email,
      password: tempPassword,
      given_name: (givenName || email.split('@')[0]).slice(0, 40),
      ...(familyName ? { family_name: familyName.slice(0, 40) } : {}),
      email_verified: false,
    }),
  })
  if (!createRes.ok) {

    console.error('[auth0] create user failed:', createRes.status, await createRes.text())
    return null
  }
  const created = (await createRes.json()) as { user_id: string }

  // Send the new member an email to set their password and activate their login.
  await fetch(`${AUTH0_DOMAIN}/dbconnections/change_password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: AUTH0_CLIENT_ID,
      email,
      connection: 'Username-Password-Authentication',
    }),
  }).catch((err: unknown) => {

    console.error('[auth0] change_password email failed:', err)
  })

  return created.user_id
}


// ---------------------------------------------------------------------------
// Simplecast episode fetch
//
// Projects the Simplecast Episodes API down to our Episode shape. Cached
// per-podcast in-process to absorb traffic on hot show pages. The cache
// resets on each serverless cold start, which is fine — Simplecast
// episodes update on the order of days, not seconds.
// ---------------------------------------------------------------------------
type ScEpisodesResponse = { collection?: ScEpisode[] }

const SIMPLECAST_CACHE_TTL_MS = 5 * 60 * 1000
const simplecastCache = new Map<string, { at: number; episodes: ProjectedEpisode[] }>()

function resolveSimplecastPodcastId(env: Env, showSlug: string): string | undefined {
  // Accept only the slug pattern we expect so a caller can't probe arbitrary
  // env keys by injecting an unusual `show` value.
  if (!/^[a-z0-9-]+$/.test(showSlug)) return undefined
  const key = `VITE_SIMPLECAST_PODCAST_ID_${showSlug.toUpperCase().replace(/-/g, '_')}`
  const value = env[key]
  return value && value.trim() ? value.trim() : undefined
}

async function fetchSimplecastEpisodes(
  podcastId: string,
  token: string,
  showSlug: string,
): Promise<ProjectedEpisode[]> {
  const cached = simplecastCache.get(podcastId)
  if (cached && Date.now() - cached.at < SIMPLECAST_CACHE_TTL_MS) {
    return cached.episodes
  }

  const url = `https://api.simplecast.com/podcasts/${encodeURIComponent(podcastId)}/episodes?limit=50`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`Simplecast ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as ScEpisodesResponse
  const episodes: ProjectedEpisode[] = (body.collection ?? [])
    // Drafts and scheduled episodes carry no published_at — drop them.
    .filter(isPublishedEpisode)
    .map((e) => projectScEpisode(e, showSlug))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))

  simplecastCache.set(podcastId, { at: Date.now(), episodes })
  return episodes
}


// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
type JsonRes = (status: number, body: unknown) => void

function makeJsonRes(res: ServerResponse): JsonRes {
  return (status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const buf = await readBody(req)
  if (!buf.length) return null
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch {
    return null
  }
}


// ---------------------------------------------------------------------------
// Token-bucket rate limiter
//
// A simple in-memory limiter sufficient for a single-process dev server.
// Production deployments behind a load balancer should swap this for Redis
// (or rely on a WAF / API gateway upstream) — buckets here are not shared
// between processes.
// ---------------------------------------------------------------------------
type Bucket = { tokens: number; updatedAt: number }
type RateLimiter = {
  /** Returns null if allowed, or the seconds the caller should wait. */
  take: (key: string) => number | null
}

function createRateLimiter(opts: {
  capacity: number
  refillPerSec: number
  maxKeys?: number
}): RateLimiter {
  const { capacity, refillPerSec } = opts
  const maxKeys = opts.maxKeys ?? 10_000
  const buckets = new Map<string, Bucket>()

  const prune = (now: number) => {
    // Drop fully-replenished buckets — they carry no state worth keeping.
    for (const [k, b] of buckets) {
      const refilled = Math.min(
        capacity,
        b.tokens + ((now - b.updatedAt) / 1000) * refillPerSec,
      )
      if (refilled >= capacity) buckets.delete(k)
    }
  }

  return {
    take(key) {
      const now = Date.now()
      let b = buckets.get(key)
      if (!b) {
        b = { tokens: capacity, updatedAt: now }
        buckets.set(key, b)
        if (buckets.size > maxKeys) prune(now)
      } else {
        const elapsedSec = (now - b.updatedAt) / 1000
        b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec)
        b.updatedAt = now
      }
      if (b.tokens >= 1) {
        b.tokens -= 1
        return null
      }
      const needed = 1 - b.tokens
      return Math.ceil(needed / refillPerSec)
    },
  }
}


// ---------------------------------------------------------------------------
// API builder — shared between the Vite dev plugin and the standalone
// serverless handler. Returns the Clerk gate config plus a flat list of
// route handlers keyed by path. Both entry points (`devApiPlugin`,
// `createApiHandler`) just decide *how* to dispatch into this list.
// ---------------------------------------------------------------------------
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

interface Api {
  appBaseUrl: string
  routes: Array<{ path: string; handler: Handler }>
}

function buildApi(env: Env): Api {
  const stripeKey = env.STRIPE_SECRET_KEY
  const stripe = stripeKey ? new Stripe(stripeKey) : null

  const appBaseUrl = env.APP_BASE_URL || 'http://localhost:5173'

  // Auth0 handles authentication. Backend verifies JWTs via Auth0's JWKS.

  // Stripe price cache — keyed by `${plan}-${amountCents}` to avoid creating
  // a fresh Price object on every pay-what-you-want checkout.
  const priceCache = new Map<string, string>()

  // SMS setup-link sender. Tight budget — SC forwards these to a carrier and
  // charges per message, so abuse is expensive. SC itself also rate-limits server-side.
  const smsSessionLimiter = createRateLimiter({
    capacity: 3,
    refillPerSec: 3 / (60 * 60), // 3 per hour per session
  })

  // /api/auth/checkout-session is polled by the client (~1 req/s during the
  // 20s window after payment). Cap per Stripe subscription to defend the
  // upstream Stripe and Auth0 APIs from runaway loops or scripted abuse.
  const checkoutSessionLimiter = createRateLimiter({
    capacity: 25,
    refillPerSec: 1,
  })

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

  const resolveScGiftPriceId = (term: GiftTerm): number => {
    const id =
      term === '6mo'
        ? env.SC_SUBSCRIPTION_PRICE_ID_GIFT_6MO
        : env.SC_SUBSCRIPTION_PRICE_ID_GIFT_1YR
    const envKey =
      term === '6mo'
        ? 'SC_SUBSCRIPTION_PRICE_ID_GIFT_6MO'
        : 'SC_SUBSCRIPTION_PRICE_ID_GIFT_1YR'
    if (!id) throw new Error(`${envKey} must be set in .env`)
    return Number(id)
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
    //
    // If we ever manage users in our own DB, set `external_id` here to link
    // the SC user to our internal record (e.g. external_id: our_user.id).
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

    const endsAt = new Date(
      Date.now() + GIFT_TERM_DAYS[term] * 24 * 60 * 60 * 1000,
    ).toISOString()

    const createdSub = await sc.call<{ subscription: { id: number } }>(
      'POST',
      '/subscriptions',
      {
        user_id: recipient.id,
        subscription_price_id: scPriceId,
        ends_at: endsAt,
      },
    )

    let auth0UserId: string | null = null
    try {
      auth0UserId = await findOrCreateAuth0User(recipientEmail, recipientName, env)
    } catch (err) {

      console.error('[auth0] findOrCreateAuth0User (gift) failed:', err)
    }

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
  }

  // Concurrent callers (webhook + /api/auth/checkout-session) can both try to
  // provision the same subscription within ms of each other. Without a lock
  // we'd create two SC subscriptions for the same user. Dedupe by Stripe sub
  // id: the second caller waits on the first's promise and then re-reads
  // Stripe metadata (set by the winner) to early-return cleanly.
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
    const created = await sc.call<{ subscription: { id: number } }>(
      'POST',
      '/subscriptions',
      { user_id: user.id, subscription_price_id: Number(scPriceId) },
    )

    let auth0UserId: string | null = null
    try {
      auth0UserId = await findOrCreateAuth0User(email, activeCustomer.name ?? undefined, env)
    } catch (err) {

      console.error('[auth0] findOrCreateAuth0User failed:', err)
    }

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

  const routes: Api['routes'] = []

      // --- Simplecast episode catalog --------------------------------------
      // Proxies the Simplecast API and projects the response down to our
      // Episode shape. Cached in-process for SIMPLECAST_CACHE_TTL_MS to keep
      // hot show pages from hammering the upstream API.
      routes.push({
        path: '/api/simplecast/episodes',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

          const url = new URL(req.url ?? '', 'http://x')
          const show = url.searchParams.get('show')
          if (!show) return json(400, { error: 'missing `show`' })

          const podcastId = resolveSimplecastPodcastId(env, show)
          const token = env.SIMPLECAST_API_TOKEN
          if (!podcastId || !token) {
            // Show has no Simplecast podcast configured, or the server has no
            // token. Return an empty list — the client falls back to mocks.
            return json(200, { episodes: [] })
          }

          try {
            const episodes = await fetchSimplecastEpisodes(podcastId, token, show)
            json(200, { episodes })
          } catch (err) {
            console.error('[simplecast] fetch failed:', err)
            json(502, { error: 'simplecast_unavailable' })
          }
        },
      })

      // --- Who am I (+ personalized feeds) ---------------------------------
      routes.push({
        path: '/api/me',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          const email = await getSessionEmail(req, env)
          if (!email) return json(401, { error: 'unauthenticated' })

          try {
            const sc = createScClient(env)
            const user = await findScUserByEmail(sc, email)
            if (!user) return json(401, { error: 'membership_not_found' })
            let feeds: ScUserFeed[] = []
            try {
              const feedsRes = await sc.call<{ feeds: ScUserFeed[] }>(
                'GET',
                `/users/${user.id}/feeds`,
              )
              feeds = feedsRes.feeds ?? []
            } catch (feedErr) {
              if ((feedErr as ScError).status !== 404) throw feedErr
              // 404 means no feeds set up yet — treat as empty
            }
            json(200, { email, feeds })
          } catch (err) {
            const e = err as ScError
            json(e.status ?? 502, { error: e.message })
          }
        },
      })

      // --- Send setup SMS --------------------------------------------------
      // Asks SC to text the signed-in user a link for setting up their feed.
      // SC's endpoint expects E.164 (+15555555555); we normalize loosely and
      // let SC return 422 for anything it can't route.
      routes.push({
        path: '/api/sc/send-setup-sms',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

          const smsEmail = await getSessionEmail(req, env)
          if (!smsEmail) return json(401, { error: 'unauthenticated' })

          const smsSc = createScClient(env)
          const smsUser = await findScUserByEmail(smsSc, smsEmail)
          if (!smsUser) return json(401, { error: 'membership_not_found' })

          const wait = smsSessionLimiter.take(String(smsUser.id))
          if (wait !== null) {
            res.setHeader('retry-after', String(wait))
            return json(429, {
              error: 'Too many SMS requests. Please wait a bit and try again.',
            })
          }

          const body = (await readJson<{ phone?: unknown; feed_id?: unknown }>(req)) ?? {}
          if (typeof body.phone !== 'string') {
            return json(400, { error: 'Phone number is required.' })
          }
          const rawPhone = body.phone.trim()
          if (!rawPhone) return json(400, { error: 'Phone number is required.' })

          // feed_id is optional but, if provided, must be a positive integer.
          // It gets interpolated into the SC path, so runtime-validate rather
          // than trusting the TS type.
          let feedId: number | undefined
          if (body.feed_id !== undefined) {
            if (
              typeof body.feed_id !== 'number' ||
              !Number.isInteger(body.feed_id) ||
              body.feed_id <= 0
            ) {
              return json(400, { error: 'Invalid feed id.' })
            }
            feedId = body.feed_id
          }

          // Normalize to E.164: remember whether the input carried a leading
          // +, strip everything else to digits, then rebuild. Bare 10-digit
          // input is assumed US (+1) — consistent with the audience default.
          const hadPlus = rawPhone.startsWith('+')
          const digits = rawPhone.replace(/\D/g, '')
          let phone: string
          if (hadPlus) {
            phone = `+${digits}`
          } else if (digits.length === 10) {
            phone = `+1${digits}`
          } else if (digits.length === 11 && digits.startsWith('1')) {
            phone = `+${digits}`
          } else {
            phone = `+${digits}`
          }
          const digitCount = phone.length - 1 // excludes the leading +
          if (digitCount < 8 || digitCount > 15) {
            return json(400, { error: "That doesn't look like a valid phone number." })
          }

          try {
            // Resolve the target feed — prefer the explicit feed_id, else the
            // first feed on the account (matches what SetupFlow displays).
            if (!feedId) {
              const feedsRes = await smsSc.call<{ feeds: ScUserFeed[] }>(
                'GET',
                `/users/${smsUser.id}/feeds`,
              )
              feedId = feedsRes.feeds?.[0]?.id
            }
            if (!feedId) return json(404, { error: 'No feed found for this account.' })

            await smsSc.call(
              'POST',
              `/users/${smsUser.id}/feeds/${feedId}/send_setup_sms`,
              { phone },
            )
            json(200, { ok: true })
          } catch (err) {
            const e = err as ScError
            if (e.status === 422) {
              return json(422, {
                error: "We couldn't send to that number. Check the format and try again.",
              })
            }
            if (e.status === 429) {
              return json(429, { error: 'SMS rate limit reached. Try again in a moment.' })
            }

            console.error('[dev-api] send_setup_sms failed:', err)
            json(e.status ?? 502, { error: 'Could not send SMS. Please try again.' })
          }
        },
      })

      // --- Stripe: create subscription -------------------------------------
      routes.push({
        path: '/api/stripe/create-subscription',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

          const body =
            (await readJson<{
              email?: string
              plan?: 'monthly' | 'yearly'
              custom_amount_cents?: number
              name?: string
            }>(req)) ?? {}

          if (!body.email) return json(400, { error: 'Email is required' })
          if (body.plan !== 'monthly' && body.plan !== 'yearly') {
            return json(400, { error: 'plan must be "monthly" or "yearly"' })
          }
          const plan = body.plan
          const interval: 'month' | 'year' = plan === 'monthly' ? 'month' : 'year'
          const defaultCents = plan === 'monthly' ? 800 : 8000

          let amountCents = defaultCents
          if (
            typeof body.custom_amount_cents === 'number' &&
            Number.isFinite(body.custom_amount_cents)
          ) {
            if (body.custom_amount_cents < defaultCents) {
              return json(400, {
                error: `Custom amount must be at least $${defaultCents / 100}.`,
              })
            }
            if (body.custom_amount_cents > 1_000_000) {
              return json(400, { error: 'Custom amount too large.' })
            }
            amountCents = Math.round(body.custom_amount_cents)
          }

          // Find-or-create Stripe customer by email.
          const existing = await stripe.customers.list({ email: body.email, limit: 1 })
          const customer =
            existing.data[0] ??
            (await stripe.customers.create({
              email: body.email,
              name: body.name,
            }))

          // Resolve price. Prefer the configured fixed price, else reuse a
          // cached dynamic one, else create + cache a new one.
          const fixedPriceId =
            plan === 'monthly' ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_YEARLY
          let priceId: string
          if (amountCents === defaultCents && fixedPriceId) {
            priceId = fixedPriceId
          } else {
            const cacheKey = `${plan}-${amountCents}`
            const cached = priceCache.get(cacheKey)
            if (cached) {
              priceId = cached
            } else {
              const price = await stripe.prices.create({
                currency: 'usd',
                unit_amount: amountCents,
                recurring: { interval },
                product_data: {
                  name: `Ark Insider — ${plan === 'monthly' ? 'Monthly' : 'Yearly'}`,
                },
              })
              priceId = price.id
              priceCache.set(cacheKey, priceId)
            }
          }

          const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            expand: ['latest_invoice.confirmation_secret'],
            metadata: {
              plan,
              custom_amount_cents: String(amountCents),
            },
          })

          const invoice = subscription.latest_invoice as Stripe.Invoice | null
          const clientSecret = invoice?.confirmation_secret?.client_secret
          if (!clientSecret) {
            return json(500, { error: 'Could not obtain payment client secret' })
          }

          json(200, {
            subscription_id: subscription.id,
            client_secret: clientSecret,
            amount_cents: amountCents,
            plan,
          })
        },
      })

      // --- Gift: create one-time PaymentIntent -----------------------------
      routes.push({
        path: '/api/gift/create-checkout',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

          const body =
            (await readJson<{
              giver_email?: string
              giver_name?: string
              recipient_email?: string
              recipient_name?: string
              term?: GiftTerm
              message?: string
            }>(req)) ?? {}

          const giverEmail = body.giver_email?.trim().toLowerCase()
          const recipientEmail = body.recipient_email?.trim().toLowerCase()
          if (!giverEmail) return json(400, { error: 'Your email is required.' })
          if (!recipientEmail) return json(400, { error: "Recipient's email is required." })
          if (body.term !== '6mo' && body.term !== '1yr') {
            return json(400, { error: 'term must be "6mo" or "1yr"' })
          }
          if (body.message && body.message.length > 500) {
            return json(400, { error: 'Message is too long (max 500 characters).' })
          }

          const term = body.term
          const amountCents = GIFT_PRICES_CENTS[term]

          const existing = await stripe.customers.list({ email: giverEmail, limit: 1 })
          const customer =
            existing.data[0] ??
            (await stripe.customers.create({
              email: giverEmail,
              name: body.giver_name,
            }))

          const pi = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'usd',
            customer: customer.id,
            receipt_email: giverEmail,
            description: `Ark Insider gift · ${term === '6mo' ? '6 months' : '1 year'}`,
            metadata: {
              kind: 'gift',
              term,
              giver_email: giverEmail,
              giver_name: body.giver_name ?? '',
              recipient_email: recipientEmail,
              recipient_name: body.recipient_name ?? '',
              message: body.message ?? '',
            },
          })

          if (!pi.client_secret) {
            return json(500, { error: 'Could not obtain payment client secret' })
          }

          json(200, {
            payment_intent_id: pi.id,
            client_secret: pi.client_secret,
            amount_cents: amountCents,
            term,
          })
        },
      })

      // --- Gift: poll for activation ---------------------------------------
      routes.push({
        path: '/api/gift/status',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
          const url = new URL(req.url ?? '/', appBaseUrl)
          const piId = url.searchParams.get('id')
          if (!piId) return json(400, { error: 'id required' })

          // Ownership check: the giver just created this PI moments ago, so
          // an email param matching the PI's metadata is sufficient proof
          // (same pattern as /api/stripe/subscription-status).
          const emailParam = url.searchParams.get('email')?.trim().toLowerCase()
          const pi = await stripe.paymentIntents.retrieve(piId)
          const giver = pi.metadata?.giver_email?.toLowerCase()
          if (!emailParam || !giver || emailParam !== giver) {
            return json(403, { error: 'Forbidden' })
          }

          json(200, {
            status: pi.status,
            activated: Boolean(pi.metadata?.sc_subscription_id),
          })
        },
      })

      // --- Cancel subscription -----------------------------------------------
      routes.push({
        path: '/api/stripe/cancel-subscription',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

          const cancelEmail = await getSessionEmail(req, env)
          if (!cancelEmail) return json(401, { error: 'unauthenticated' })

          // Find the Stripe customer by email
          const customers = await stripe.customers.list({
            email: cancelEmail,
            limit: 1,
          })
          const customer = customers.data[0]
          if (!customer) return json(404, { error: 'No billing record found' })

          // Find their active subscription
          const subs = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'active',
            limit: 1,
          })
          const sub = subs.data[0]
          if (!sub) return json(404, { error: 'No active subscription found' })

          // Cancel at period end so they keep access until the billing cycle ends
          await stripe.subscriptions.update(sub.id, {
            cancel_at_period_end: true,
          })

          const periodEnd = new Date(sub.items.data[0].current_period_end * 1000).toISOString()
          json(200, { ok: true, access_until: periodEnd })
        },
      })

      // --- Poll for activation after payment -------------------------------
      routes.push({
        path: '/api/stripe/subscription-status',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
          const url = new URL(req.url ?? '/', appBaseUrl)
          const subId = url.searchParams.get('id')
          if (!subId) return json(400, { error: 'id required' })

          // Verify the caller owns this subscription. New subscribers may not
          // have an Auth0 session yet (they just paid), so we accept an `email`
          // query param as a fallback — the email was just used to create the
          // subscription moments ago.
          const emailParam = url.searchParams.get('email')?.trim().toLowerCase()
          const auth0Email = await getSessionEmail(req, env)
          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ['customer'],
          })
          const customer = sub.customer
          const customerEmail =
            typeof customer === 'object' && customer && !('deleted' in customer && customer.deleted)
              ? (customer as Stripe.Customer).email?.toLowerCase() ?? null
              : null
          const callerEmail = auth0Email ?? emailParam
          if (!callerEmail || callerEmail !== customerEmail) {
            return json(403, { error: 'Forbidden' })
          }

          json(200, {
            status: sub.status,
            activated: Boolean(sub.metadata?.sc_subscription_id),
          })
        },
      })

      // --- Checkout session: auto-login after subscription ----------------
      // Brand-new subscribers don't have an Auth0 password yet — the webhook
      // sends them a password-reset email so they can pick one for future
      // logins. To get them into /setup immediately without round-tripping
      // through that email, we provision their account synchronously here and
      // hand back a short-lived HS256 JWT the client can use as a Bearer
      // token. /api/me + friends accept either Auth0 RS256 tokens or this
      // token (see verifyCheckoutToken / getSessionEmail).
      //
      // Ownership: the email is verified against the Stripe customer record
      // (same pattern as /api/stripe/subscription-status), which the caller
      // just created moments ago.
      routes.push({
        path: '/api/auth/checkout-session',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
          if (!env.CHECKOUT_SESSION_SECRET) {
            return json(500, { error: 'CHECKOUT_SESSION_SECRET missing' })
          }

          const body =
            (await readJson<{ subscription_id?: string; email?: string }>(req)) ?? {}
          const subId = body.subscription_id?.trim()
          const emailParam = body.email?.trim().toLowerCase()
          if (!subId) return json(400, { error: 'subscription_id required' })
          if (!emailParam) return json(400, { error: 'email required' })

          const wait = checkoutSessionLimiter.take(subId)
          if (wait !== null) {
            res.setHeader('retry-after', String(wait))
            return json(429, { error: 'Too many attempts. Please wait a moment.' })
          }

          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ['customer'],
          })
          const customer = sub.customer
          const customerEmail =
            typeof customer === 'object' &&
            customer &&
            !('deleted' in customer && customer.deleted)
              ? (customer as Stripe.Customer).email?.toLowerCase() ?? null
              : null
          if (!customerEmail || customerEmail !== emailParam) {
            return json(403, { error: 'Forbidden' })
          }

          // Defense against replay of leaked (subscription_id, email) pairs:
          // auto-login is only valid during the brief window right after
          // checkout. After that, the user logs in normally via Auth0 with
          // the password they set from the reset email.
          const AUTO_LOGIN_WINDOW_SEC = 60 * 60 // 1 hour
          if (Date.now() / 1000 - sub.created > AUTO_LOGIN_WINDOW_SEC) {
            return json(410, {
              error: 'Auto-login window expired. Please sign in via the link in your welcome email.',
            })
          }

          // Stripe moves a default_incomplete subscription to `active` only
          // after the PaymentIntent confirms. The client calls this endpoint
          // right after confirmPayment resolves, but Stripe's internal state
          // transition can lag by a few hundred ms. Tell the client to retry.
          if (sub.status !== 'active' && sub.status !== 'trialing') {
            return json(202, { ready: false, status: sub.status })
          }

          // Provision SC user + SC subscription + Auth0 user. Idempotent — if
          // the webhook already ran, this is a no-op. Failures here mean the
          // caller paid but provisioning is incomplete; the webhook will
          // retry async, but we shouldn't hand out a session token yet.
          try {
            await activateScSubscriptionForStripeSub(sub)
          } catch (err) {

            console.error('[auth/checkout-session] provision failed:', err)
            return json(502, {
              error: 'Could not finish setting up your account. Please try again.',
            })
          }

          const accessToken = await signCheckoutToken(customerEmail, env)
          setCheckoutCookies(res, accessToken, env)
          json(200, {
            ready: true,
            email: customerEmail,
            expires_in: CHECKOUT_TOKEN_TTL_SEC,
          })
        },
      })

      // --- Sign out -------------------------------------------------------
      // Clears the checkout-session cookies. The client invokes this before
      // triggering Auth0's logout redirect so brand-new subscribers can fully
      // sign out without leaving a 30-min cookie behind.
      routes.push({
        path: '/api/signout',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          clearCheckoutCookies(res, env)
          json(200, { ok: true })
        },
      })

      // --- Stripe webhook --------------------------------------------------
      // NOTE: This handler reads the raw request body directly. In production
      // with Express/body-parser, ensure raw body is preserved for this route
      // (e.g. via `express.raw({ type: 'application/json' })`) — otherwise
      // Stripe signature verification will fail on the parsed body.
      routes.push({
        path: '/api/stripe/webhook',
        handler: async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
          const whSecret = env.STRIPE_WEBHOOK_SECRET
          if (!whSecret) return json(500, { error: 'STRIPE_WEBHOOK_SECRET missing' })

          const sig = req.headers['stripe-signature']
          if (typeof sig !== 'string') return json(400, { error: 'Missing signature' })

          const raw = await readBody(req)
          let event: Stripe.Event
          try {
            event = stripe.webhooks.constructEvent(raw, sig, whSecret)
          } catch (err) {
            return json(400, {
              error: `Webhook signature verification failed: ${
                err instanceof Error ? err.message : 'unknown'
              }`,
            })
          }

          try {
            switch (event.type) {
              case 'customer.subscription.created':
              case 'customer.subscription.updated': {
                const sub = event.data.object as Stripe.Subscription
                if (sub.status === 'active' || sub.status === 'trialing') {
                  await activateScSubscriptionForStripeSub(sub)
                }
                break
              }
              case 'customer.subscription.deleted':
              case 'customer.subscription.paused': {
                const sub = event.data.object as Stripe.Subscription
                const scSubId = sub.metadata?.sc_subscription_id
                if (scSubId) {
                  const sc = createScClient(env)
                  try {
                    await sc.call('DELETE', `/subscriptions/${scSubId}`)
                  } catch (err) {

                    console.error('[dev-api] SC cancel failed:', err)
                  }
                }
                break
              }
              case 'payment_intent.succeeded': {
                const pi = event.data.object as Stripe.PaymentIntent
                if (pi.metadata?.kind === 'gift') {
                  await activateScGiftForPaymentIntent(pi)
                }
                break
              }
              case 'invoice.payment_failed': {

                console.warn(
                  '[stripe] invoice.payment_failed',
                  (event.data.object as Stripe.Invoice).id,
                )
                break
              }
              default:
                break
            }
            json(200, { received: true })
          } catch (err) {

            console.error('[dev-api] webhook handler error:', err)
            if (err && typeof err === 'object' && 'data' in err) {
              console.error('[dev-api] webhook error data:', JSON.stringify((err as { data: unknown }).data, null, 2))
            }
            json(500, {
              error: err instanceof Error ? err.message : 'Webhook handler error',
            })
          }
        },
      })

  // --- Circle SSO: mint a signed JWT for seamless Circle community auth ----
  // Circle redirects unauthenticated users to <your_sso_url>?return_to=<dest>.
  // The frontend /circle-sso page calls this endpoint with the Auth0 Bearer
  // token; we verify it, sign a Circle JWT (HS256), and return the redirect URL.
  routes.push({
    path: '/api/circle-sso',
    handler: async (req, res) => {
      const json = makeJsonRes(res)
      if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

      const circleSecret = env.CIRCLE_SSO_SECRET
      if (!circleSecret) return json(500, { error: 'CIRCLE_SSO_SECRET not configured' })

      let email: string | null = null
      let name: string | undefined
      const authHeader = req.headers.authorization
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7)
        try {
          const { payload } = await jwtVerify(token, jwks, {
            issuer: `${AUTH0_DOMAIN}/`,
            audience: AUTH0_AUDIENCE,
          })
          email = (payload[EMAIL_CLAIM] as string | undefined) ?? null
          name = (payload['name'] as string | undefined) ?? undefined
        } catch {
          // Not an Auth0 token — could still be a checkout-session token
          // mistakenly passed as Bearer (older clients).
          email = await verifyCheckoutToken(token, env)
        }
      }
      if (!email) {
        const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
        if (cookieToken) email = await verifyCheckoutToken(cookieToken, env)
      }
      if (!email) return json(401, { error: 'unauthenticated' })

      const body = (await readJson<{ return_to?: unknown }>(req)) ?? {}
      const returnTo = typeof body.return_to === 'string' ? body.return_to : '/'

      const secret = new TextEncoder().encode(circleSecret)
      const circleJwt = await new SignJWT({
        email,
        name: name ?? email.split('@')[0],
        user_token: email,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(secret)

      json(200, {
        jwt: circleJwt,
        redirect_url: `https://app.arkmedia.org/sso?jwt=${encodeURIComponent(circleJwt)}&return_to=${encodeURIComponent(returnTo)}`,
      })
    },
  })

  return { appBaseUrl, routes }
}

// ---------------------------------------------------------------------------
// Vite dev plugin — registers each route as Connect middleware under its path.
// Keeps the exact surface the tests rely on (`plugin.configureServer(fake)`
// captures a handler per path via `server.middlewares.use(path, handler)`).
// ---------------------------------------------------------------------------
export function devApiPlugin(env: Env): Plugin {
  const api = buildApi(env)

  const withErrors =
    (handler: Handler) =>
    (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
      handler(req, res).catch((err: unknown) => {

        console.error('[dev-api]', err)
        if (err && typeof err === 'object' && 'data' in err) {
          console.error(
            '[dev-api] error data:',
            JSON.stringify((err as { data: unknown }).data, null, 2),
          )
        }
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Internal error',
            }),
          )
        } else {
          next(err as Error)
        }
      })
    }

  return {
    name: 'ark-insider-dev-api',
    configureServer(server) {
      // Register API routes. Auth0 JWTs are verified per-route via JWKS.
      for (const { path, handler } of api.routes) {
        server.middlewares.use(path, withErrors(handler))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Catch-all handler factory — for Vercel Node Functions.
//
// Vercel's Hobby plan caps Serverless Functions at 12 per deployment, so
// instead of one file per route we expose a single `api/handler.ts` and use a
// vercel.json rewrite (`/api/(.*)` → `/api/handler?_path=$1`) to route every
// request through it. The original path arrives via the `_path` query param.
//
// Why the rewrite: Vercel's `[...slug]` filename pattern is a Next.js
// convention. In a plain Vite project it gets interpreted as a single-segment
// dynamic route, so `/api/foo` matches but `/api/foo/bar` returns NOT_FOUND.
//
// Init is guarded so a missing or malformed env var (e.g. a Stripe key that
// rejects at construction) surfaces as a readable JSON 500 instead of
// Vercel's opaque FUNCTION_INVOCATION_FAILED.
// ---------------------------------------------------------------------------
export function createCatchAllHandler(env: Env) {
  let routesByPath: Map<string, Handler> | null = null
  let initError: unknown = null

  try {
    const api = buildApi(env)
    routesByPath = new Map(api.routes.map((r) => [r.path, r.handler]))
  } catch (err) {
    initError = err
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (initError || !routesByPath) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          error: 'API failed to initialize',
          message:
            initError instanceof Error
              ? initError.message
              : String(initError ?? 'unknown'),
          stack: initError instanceof Error ? initError.stack : undefined,
        }),
      )
      return
    }

    // vercel.json rewrites `/api/*` to `/api/handler?_path=*`, so the original
    // path arrives in the `_path` query param. Fall back to the URL pathname
    // for non-Vercel callers (the dev server, tests) where the handler is
    // mounted directly at each route.
    const url = new URL(req.url ?? '', 'http://x')
    const slug = url.searchParams.get('_path')
    const pathname = slug !== null ? `/api/${slug}` : url.pathname
    const handler = routesByPath.get(pathname)
    if (!handler) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'not_found', path: pathname }))
      return
    }

    try {
      await handler(req, res)
    } catch (err) {

      console.error('[api]', err)
      if (err && typeof err === 'object' && 'data' in err) {
        console.error(
          '[api] error data:',
          JSON.stringify((err as { data: unknown }).data, null, 2),
        )
      }
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'Internal error',
          }),
        )
      }
    }
  }
}
