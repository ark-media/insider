// ---------------------------------------------------------------------------
// Ark Insider — dev API plugin
//
// This is the dev-server backend for the marketing site. It handles three
// concerns: Supporting Cast (SC) magic-link auth, Stripe checkout, and the
// SC ↔ Stripe glue via webhooks. Everything runs as Vite middleware against
// node http, so it's fine for development; production should swap this for
// a real server (the same shapes will port over).
//
// AUTH MODEL — SC magic links without a token-exchange endpoint
// =============================================================
// Supporting Cast's API exposes `POST /users/{id}/send_login_email` (which
// accepts a `redirect_url`) but **no endpoint to verify a token returned in
// that redirect**. Their session lives on the SC domain, not ours, and we
// cannot read it cross-origin. So we run our own session, anchored on the
// email-ownership proof a magic link already provides:
//
//   1. POST /api/sc/signin { email }
//        - Rate-limited per IP and per email.
//        - Looks up the SC user via /users/search.
//        - Mints an HMAC-signed nonce (NoncePayload, 15-minute TTL).
//        - Asks SC to email a login link with redirect_url pointing at our
//          /api/sc/callback?t=<nonce>.
//        - Always returns 200, so attackers can't enumerate memberships.
//
//   2. User clicks the link → SC authenticates them on the SC domain →
//      SC redirects to /api/sc/callback?t=<nonce>.
//
//   3. GET /api/sc/callback
//        - Verifies the HMAC + expiry.
//        - Marks the nonce consumed (single-use replay protection).
//        - Re-resolves the SC user (so a deleted-then-recreated user
//          doesn't accidentally inherit a stale id).
//        - Sets an httpOnly `insider_session` cookie containing
//          { email, sc_user_id, exp } and 302s to /#setup.
//
//   4. GET /api/me
//        - Reads the session cookie and calls SC /users/{id}/feeds for the
//          per-user feed URL and per-app deep links.
//        - Clears the cookie if SC says the user is gone (404).
//
//   5. POST /api/signout clears the cookie.
//
// The single security claim: the only way to land on /api/sc/callback with
// a valid (nonce, sig) pair is to have requested the email AND clicked the
// link in the matching inbox. Forging the redirect requires the session
// secret (server-side only). Replays are blocked by the consumed-nonce set.
// ---------------------------------------------------------------------------

import type { Plugin, Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import crypto from 'node:crypto'
import Stripe from 'stripe'
import { createClerkClient } from '@clerk/backend'

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

type SessionPayload = {
  email: string
  sc_user_id: number
  exp: number // unix seconds
}

type NoncePayload = {
  email: string
  exp: number
}

const SESSION_COOKIE = 'insider_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
const NONCE_TTL_SECONDS = 60 * 15 // 15 minutes

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
// HMAC-signed token helpers (sessions + sign-in nonces)
// ---------------------------------------------------------------------------
function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(str: string): Buffer {
  const pad = 4 - (str.length % 4 || 4)
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + (pad < 4 ? '='.repeat(pad) : '')
  return Buffer.from(s, 'base64')
}

function signToken<T>(secret: string, payload: T): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
  const mac = crypto.createHmac('sha256', secret).update(body).digest()
  return `${body}.${b64urlEncode(mac)}`
}

function verifyToken<T>(secret: string, token: string): T | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, macStr] = parts
  const expected = crypto.createHmac('sha256', secret).update(body).digest()
  let received: Buffer
  try {
    received = b64urlDecode(macStr)
  } catch {
    return null
  }
  if (received.length !== expected.length) return null
  if (!crypto.timingSafeEqual(received, expected)) return null
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as T & {
      exp?: unknown
    }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      // Every token we mint carries an exp. A token without one is malformed
      // (or maliciously crafted to dodge the expiry check) — reject it.
      return null
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload as T
  } catch {
    return null
  }
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

function clientIp(req: IncomingMessage): string {
  // In dev there's no trusted reverse proxy, so ignore X-Forwarded-For to
  // prevent attackers from spoofing IPs to bypass rate limiting. Production
  // deployments behind a trusted proxy should re-enable XFF parsing here.
  return req.socket.remoteAddress ?? 'unknown'
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

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = decodeURIComponent(part.slice(idx + 1).trim())
    if (k) out[k] = v
  }
  return out
}

function cookieFlags(secure: boolean): string {
  return `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`
}

function setSessionCookie(
  res: ServerResponse,
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
) {
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(secure)}; Max-Age=${maxAgeSeconds}`,
  )
}

function clearSessionCookie(res: ServerResponse, secure: boolean) {
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=; ${cookieFlags(secure)}; Max-Age=0`,
  )
}

function readSession(req: IncomingMessage, secret: string): SessionPayload | null {
  const cookies = parseCookies(req.headers.cookie)
  const token = cookies[SESSION_COOKIE]
  if (!token) return null
  return verifyToken<SessionPayload>(secret, token)
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function devApiPlugin(env: Env): Plugin {
  const stripeKey = env.STRIPE_SECRET_KEY
  const stripe = stripeKey ? new Stripe(stripeKey) : null

  const sessionSecret =
    env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
  if (!env.SESSION_SECRET) {
    // eslint-disable-next-line no-console
    console.warn(
      '[dev-api] SESSION_SECRET not set — generated an ephemeral one. Sessions will reset on server restart.',
    )
  }

  const appBaseUrl = env.APP_BASE_URL || 'http://localhost:5173'
  const cookieSecure = appBaseUrl.startsWith('https://')

  // Preview-access gate: require a Clerk session on every /api/* request
  // except webhooks (external callers) and the SC magic-link callback
  // (hit from email links where the browser may not have a Clerk cookie).
  const clerkSecret = env.CLERK_SECRET_KEY
  const clerkPublishable =
    env.CLERK_PUBLISHABLE_KEY || env.VITE_CLERK_PUBLISHABLE_KEY
  const clerk = clerkSecret
    ? createClerkClient({
        secretKey: clerkSecret,
        publishableKey: clerkPublishable,
      })
    : null
  if (!clerk) {
    // eslint-disable-next-line no-console
    console.warn(
      '[dev-api] CLERK_SECRET_KEY not set — API is ungated. Set it to enable the preview-access gate.',
    )
  }
  const clerkExemptPaths = new Set(['/stripe/webhook', '/sc/callback'])

  // Dev-only bypass for the SC magic-link step. When enabled, /api/sc/signin
  // mints the session cookie directly after confirming the SC user exists,
  // skipping send_login_email entirely. Useful when the SC network domain
  // allowlist blocks localhost redirects. NEVER enable in production.
  const allowDevSignin = env.ALLOW_DEV_SIGNIN === '1'
  if (allowDevSignin) {
    // eslint-disable-next-line no-console
    console.warn(
      '[dev-api] ALLOW_DEV_SIGNIN=1 — /api/sc/signin will mint sessions directly. Do not run this in production.',
    )
  }

  // Stripe price cache — keyed by `${plan}-${amountCents}` to avoid creating
  // a fresh Price object on every pay-what-you-want checkout.
  const priceCache = new Map<string, string>()

  // Single-use sign-in nonces. We track the nonce → its own expiry (unix
  // seconds) so we can prune entries individually instead of wiping the
  // whole set on overflow (which would briefly re-open the replay window
  // for the most recent ~N nonces). In-memory, so it resets on restart —
  // fine for dev; production should use Redis or similar.
  const consumedNonces = new Map<string, number>()
  const NONCE_STORE_MAX = 5000

  // Rate limiters guarding /api/sc/signin. Two buckets per request: one
  // per source IP (anti-flood) and one per normalized email (prevents
  // someone hammering one inbox even from rotating IPs). Both must allow
  // the call to proceed.
  //
  // Tuning rationale: legit users only need 1–2 sign-in emails per session.
  // Generous enough not to block humans, tight enough that an attacker
  // can't burn through SC's email quota.
  const signinIpLimiter = createRateLimiter({
    capacity: 10, // burst
    refillPerSec: 10 / (15 * 60), // 10 per 15 min
  })
  const signinEmailLimiter = createRateLimiter({
    capacity: 5,
    refillPerSec: 5 / (60 * 60), // 5 per hour
  })

  // SMS setup-link sender. Tight budget — SC forwards these to a carrier and
  // charges per message, so abuse is expensive. Per-session here because the
  // route requires a signed-in user; SC itself also rate-limits server-side.
  const smsSessionLimiter = createRateLimiter({
    capacity: 3,
    refillPerSec: 3 / (60 * 60), // 3 per hour per session
  })

  const pruneConsumedNonces = (): void => {
    const now = Math.floor(Date.now() / 1000)
    for (const [nonce, exp] of consumedNonces) {
      if (exp <= now) consumedNonces.delete(nonce)
    }
  }

  const recordConsumedNonce = (nonce: string, exp: number): void => {
    consumedNonces.set(nonce, exp)
    if (consumedNonces.size > NONCE_STORE_MAX) pruneConsumedNonces()
  }

  const route =
    (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
      handler(req, res).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[dev-api]', err)
        if (err && typeof err === 'object' && 'data' in err) {
          console.error('[dev-api] error data:', JSON.stringify((err as { data: unknown }).data, null, 2))
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

    await stripe.paymentIntents.update(pi.id, {
      metadata: {
        ...pi.metadata,
        sc_user_id: String(recipient.id),
        sc_subscription_id: String(createdSub.subscription.id),
      },
    })

    // Welcome email to the recipient. Soft-fail: the gift is already granted.
    try {
      await sc.call('POST', `/users/${recipient.id}/send_welcome_email`, {})
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[dev-api] gift send_welcome_email failed:', err)
    }
  }

  const activateScSubscriptionForStripeSub = async (
    sub: Stripe.Subscription,
  ): Promise<void> => {
    if (!stripe) return
    if (sub.metadata?.sc_subscription_id) return // already granted

    const customerId =
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted) throw new Error('Stripe customer was deleted')
    const email = customer.email
    if (!email) throw new Error('Stripe customer has no email')

    const plan =
      (sub.metadata?.plan as 'monthly' | 'yearly' | undefined) ?? 'yearly'

    const scPriceId = resolveScPriceId(plan)

    const sc = createScClient(env)
    const user = await findOrCreateScUser(sc, email, customer.name ?? undefined)
    const created = await sc.call<{ subscription: { id: number } }>(
      'POST',
      '/subscriptions',
      { user_id: user.id, subscription_price_id: Number(scPriceId) },
    )

    await stripe.subscriptions.update(sub.id, {
      metadata: {
        ...sub.metadata,
        sc_user_id: String(user.id),
        sc_subscription_id: String(created.subscription.id),
      },
    })

    // Fire the login email so they can sign in immediately. Log failures —
    // the subscription is still active; this is a soft failure.
    try {
      await sc.call('POST', `/users/${user.id}/send_login_email`, {
        redirect_url: buildSigninRedirectUrl(email),
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[dev-api] send_login_email failed after activation:', err)
    }
  }

  const buildSigninRedirectUrl = (email: string): string => {
    const nonce = signToken<NoncePayload>(sessionSecret, {
      email,
      exp: Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS,
    })
    const url = new URL('/api/sc/callback', appBaseUrl)
    url.searchParams.set('t', nonce)
    return url.toString()
  }

  return {
    name: 'ark-insider-dev-api',
    configureServer(server) {
      // --- Clerk gate -------------------------------------------------------
      // Runs before every /api/* route. Mounted at '/api', so req.url inside
      // the handler is the sub-path (e.g. '/stripe/webhook').
      if (clerk) {
        server.middlewares.use('/api', async (req, res, next) => {
          const subPath = (req.url ?? '/').split('?')[0]
          if (clerkExemptPaths.has(subPath)) return next()

          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) {
            if (Array.isArray(v)) headers.set(k, v.join(', '))
            else if (typeof v === 'string') headers.set(k, v)
          }
          const request = new Request(
            new URL(`/api${req.url ?? '/'}`, appBaseUrl).toString(),
            { method: req.method, headers },
          )

          try {
            const state = await clerk.authenticateRequest(request)
            if (!state.isSignedIn) {
              res.statusCode = 401
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ error: 'unauthenticated' }))
              return
            }
            next()
          } catch {
            res.statusCode = 401
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'unauthenticated' }))
          }
        })
      }

      // --- Send login email -------------------------------------------------
      server.middlewares.use(
        '/api/sc/signin',
        route(async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

          const ipWait = signinIpLimiter.take(clientIp(req))
          if (ipWait !== null) {
            res.setHeader('retry-after', String(ipWait))
            return json(429, { error: 'Too many sign-in attempts. Try again shortly.' })
          }

          const body = (await readJson<{ email?: string }>(req)) ?? {}
          if (!body.email) return json(400, { error: 'Email is required' })
          const normalizedEmail = body.email.trim().toLowerCase()

          const emailWait = signinEmailLimiter.take(normalizedEmail)
          if (emailWait !== null) {
            res.setHeader('retry-after', String(emailWait))
            return json(429, {
              error: 'Too many sign-in attempts for this email. Try again later.',
            })
          }

          // Always return 200 regardless of whether the email matches a member.
          // Prevents membership enumeration.
          const sc = createScClient(env)
          try {
            const user = await findScUserByEmail(sc, normalizedEmail)
            if (user && allowDevSignin) {
              const session = signToken<SessionPayload>(sessionSecret, {
                email: normalizedEmail,
                sc_user_id: user.id,
                exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
              })
              setSessionCookie(res, session, SESSION_TTL_SECONDS, cookieSecure)
              return json(200, { ok: true, bypass: true })
            }
            if (user) {
              await sc.call('POST', `/users/${user.id}/send_login_email`, {
                redirect_url: buildSigninRedirectUrl(normalizedEmail),
              })
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[dev-api] signin error (swallowed):', err)
          }
          json(200, { ok: true })
        }),
      )

      // --- Magic link callback ---------------------------------------------
      server.middlewares.use(
        '/api/sc/callback',
        route(async (req, res) => {
          const url = new URL(req.url ?? '/', appBaseUrl)
          const token = url.searchParams.get('t') ?? ''
          const payload = verifyToken<NoncePayload>(sessionSecret, token)

          const bounceHome = (msg?: string) => {
            const dest = new URL('/', appBaseUrl)
            if (msg) dest.searchParams.set('signin_error', msg)
            res.statusCode = 302
            res.setHeader('location', dest.toString())
            res.end()
          }

          if (!payload) return bounceHome('invalid_or_expired')
          if (consumedNonces.has(token)) return bounceHome('already_used')
          recordConsumedNonce(token, payload.exp)

          // Resolve the current SC user for this email so the session carries
          // their id (used by /api/me).
          let scUserId = 0
          try {
            const sc = createScClient(env)
            const user = await findScUserByEmail(sc, payload.email)
            if (!user) return bounceHome('no_membership')
            scUserId = user.id
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[dev-api] callback SC lookup failed:', err)
            return bounceHome('sc_error')
          }

          const session = signToken<SessionPayload>(sessionSecret, {
            email: payload.email,
            sc_user_id: scUserId,
            exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
          })
          setSessionCookie(res, session, SESSION_TTL_SECONDS, cookieSecure)

          const dest = new URL('/', appBaseUrl)
          dest.hash = 'setup'
          res.statusCode = 302
          res.setHeader('location', dest.toString())
          res.end()
        }),
      )

      // --- Sign out ---------------------------------------------------------
      server.middlewares.use(
        '/api/signout',
        route(async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          clearSessionCookie(res, cookieSecure)
          json(200, { ok: true })
        }),
      )

      // --- Who am I (+ personalized feeds) ---------------------------------
      server.middlewares.use(
        '/api/me',
        route(async (req, res) => {
          const json = makeJsonRes(res)
          const session = readSession(req, sessionSecret)
          if (!session) return json(401, { error: 'unauthenticated' })

          try {
            const sc = createScClient(env)
            const feedsRes = await sc.call<{ feeds: ScUserFeed[] }>(
              'GET',
              `/users/${session.sc_user_id}/feeds`,
            )
            json(200, {
              email: session.email,
              feeds: feedsRes.feeds ?? [],
            })
          } catch (err) {
            const e = err as ScError
            // If SC says the user is gone, clear the stale session.
            if (e.status === 404) {
              clearSessionCookie(res, cookieSecure)
              return json(401, { error: 'membership_not_found' })
            }
            json(e.status ?? 502, { error: e.message })
          }
        }),
      )

      // --- Send setup SMS --------------------------------------------------
      // Asks SC to text the signed-in user a link for setting up their feed.
      // SC's endpoint expects E.164 (+15555555555); we normalize loosely and
      // let SC return 422 for anything it can't route.
      server.middlewares.use(
        '/api/sc/send-setup-sms',
        route(async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

          const session = readSession(req, sessionSecret)
          if (!session) return json(401, { error: 'unauthenticated' })

          const wait = smsSessionLimiter.take(String(session.sc_user_id))
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
            const sc = createScClient(env)
            // Resolve the target feed — prefer the explicit feed_id, else the
            // first feed on the account (matches what SetupFlow displays).
            if (!feedId) {
              const feedsRes = await sc.call<{ feeds: ScUserFeed[] }>(
                'GET',
                `/users/${session.sc_user_id}/feeds`,
              )
              feedId = feedsRes.feeds?.[0]?.id
            }
            if (!feedId) return json(404, { error: 'No feed found for this account.' })

            await sc.call(
              'POST',
              `/users/${session.sc_user_id}/feeds/${feedId}/send_setup_sms`,
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
            // eslint-disable-next-line no-console
            console.error('[dev-api] send_setup_sms failed:', err)
            json(e.status ?? 502, { error: 'Could not send SMS. Please try again.' })
          }
        }),
      )

      // --- Stripe: create subscription -------------------------------------
      server.middlewares.use(
        '/api/stripe/create-subscription',
        route(async (req, res) => {
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
        }),
      )

      // --- Gift: create one-time PaymentIntent -----------------------------
      server.middlewares.use(
        '/api/gift/create-checkout',
        route(async (req, res) => {
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
        }),
      )

      // --- Gift: poll for activation ---------------------------------------
      server.middlewares.use(
        '/api/gift/status',
        route(async (req, res) => {
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
        }),
      )

      // --- Cancel subscription -----------------------------------------------
      server.middlewares.use(
        '/api/stripe/cancel-subscription',
        route(async (req, res) => {
          const json = makeJsonRes(res)
          if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

          const session = readSession(req, sessionSecret)
          if (!session) return json(401, { error: 'unauthenticated' })

          // Find the Stripe customer by email
          const customers = await stripe.customers.list({
            email: session.email,
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
        }),
      )

      // --- Poll for activation after payment -------------------------------
      server.middlewares.use(
        '/api/stripe/subscription-status',
        route(async (req, res) => {
          const json = makeJsonRes(res)
          if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
          const url = new URL(req.url ?? '/', appBaseUrl)
          const subId = url.searchParams.get('id')
          if (!subId) return json(400, { error: 'id required' })

          // Verify the caller owns this subscription. New subscribers won't
          // have a session yet (they haven't clicked the magic link), so we
          // accept an `email` query param as proof of ownership — the email
          // was just used to create the subscription moments ago.
          const emailParam = url.searchParams.get('email')?.trim().toLowerCase()
          const session = readSession(req, sessionSecret)
          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ['customer'],
          })
          const customer = sub.customer
          const customerEmail =
            typeof customer === 'object' && customer && !('deleted' in customer && customer.deleted)
              ? (customer as Stripe.Customer).email?.toLowerCase() ?? null
              : null
          const callerEmail = session?.email ?? emailParam
          if (!callerEmail || callerEmail !== customerEmail) {
            return json(403, { error: 'Forbidden' })
          }

          json(200, {
            status: sub.status,
            activated: Boolean(sub.metadata?.sc_subscription_id),
          })
        }),
      )

      // --- Stripe webhook --------------------------------------------------
      // NOTE: This handler reads the raw request body directly. In production
      // with Express/body-parser, ensure raw body is preserved for this route
      // (e.g. via `express.raw({ type: 'application/json' })`) — otherwise
      // Stripe signature verification will fail on the parsed body.
      server.middlewares.use(
        '/api/stripe/webhook',
        route(async (req, res) => {
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
                    // eslint-disable-next-line no-console
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
                // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
            console.error('[dev-api] webhook handler error:', err)
            if (err && typeof err === 'object' && 'data' in err) {
              console.error('[dev-api] webhook error data:', JSON.stringify((err as { data: unknown }).data, null, 2))
            }
            json(500, {
              error: err instanceof Error ? err.message : 'Webhook handler error',
            })
          }
        }),
      )
    },
  }
}
