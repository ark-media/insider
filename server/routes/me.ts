// Whoami / personalized feeds. Returns the signed-in user's SC feeds so
// the SPA can render the setup page (and decide whether to surface a "send
// SMS" button).

import { fetchAuth0TierForEmail, redactEmail } from '../entitlement.js'
import {
  applyPreferences,
  ensureFreeSubscription,
  isReceivingEmails,
  refreshSubscriptionFromBeehiiv,
} from '../lib/beehiiv-sync.js'
import { CHECKOUT_COOKIE_NAME, readCookie } from '../lib/cookies.js'
import { getDb } from '../lib/db.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import {
  verifyAuth0BearerProfile,
  verifyCheckoutToken,
} from '../lib/session.js'
import {
  createScClient,
  findScUserByEmail,
  type ScError,
  type ScUserFeed,
} from '../lib/sc-client.js'
import type { Deps, Route } from '../lib/route.js'

// Bucket the PUT route by normalized email so flapping toggles can't burn
// Beehiiv quota or rate-limit the upstream API. 10 saves per minute is more
// than any human will click; sustained refill is 1/6s.
const newsletterPrefsLimiter = createRateLimiter({
  capacity: 10,
  refillPerSec: 1 / 6,
})

export function meRoutes({ env }: Deps): Route[] {
  return [
    {
      path: '/api/me',
      handler: async (req, res) => {
        const json = makeJsonRes(res)

        // Resolve the session: an Auth0 bearer (the long-term login, carries
        // a tier claim) or the short-lived checkout token (cookie or bearer,
        // issued only post-payment so always implies subscriber). We need
        // both the email and which source authenticated, because a missing
        // SC record means different things for each: for Auth0 it means
        // "logged-in free user"; for checkout it means "provisioning gap".
        let email: string | null = null
        let claimTier: 'ark-plus-member' | 'free' | undefined
        let source: 'auth0' | 'checkout' | null = null

        const authHeader = req.headers.authorization
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7)
          const profile = await verifyAuth0BearerProfile(token)
          if (profile?.email) {
            source = 'auth0'
            email = profile.email
            claimTier = profile.tier
          } else {
            const e = await verifyCheckoutToken(token, env)
            if (e) {
              source = 'checkout'
              email = e
            }
          }
        }
        if (!email) {
          const cookieToken = readCookie(req, CHECKOUT_COOKIE_NAME)
          if (cookieToken) {
            const e = await verifyCheckoutToken(cookieToken, env)
            if (e) {
              source = 'checkout'
              email = e
            }
          }
        }
        if (!email || !source) return json(401, { error: 'unauthenticated' })

        // Always look up SC: presence there is authoritative for paid tier,
        // so a stale 'free' JWT for a recently-upgraded user still surfaces
        // subscriber state without waiting for the next token refresh.
        try {
          const sc = createScClient(env)
          const user = await findScUserByEmail(sc, email)
          if (user) {
            let feeds: ScUserFeed[] = []
            try {
              const feedsRes = await sc.call<{ feeds: ScUserFeed[] }>(
                'GET',
                `/users/${user.id}/feeds`,
              )
              feeds = feedsRes.feeds ?? []
            } catch (feedErr) {
              if ((feedErr as ScError).status !== 404) throw feedErr
              // 404 means no feeds set up yet — treat as empty.
            }
            return json(200, { email, tier: 'ark-plus-member', feeds })
          }

          // No SC record. For Auth0 sessions whose JWT isn't claiming
          // 'ark-plus-member', treat as a logged-in free user. For the
          // checkout-cookie path (issued only after payment) a missing SC
          // user is a provisioning gap, so keep the 401 contract.
          if (source === 'auth0' && claimTier !== 'ark-plus-member') {
            // First-login auto-subscribe to the free newsletter.
            // Soft-fails internally so a Beehiiv outage can't block login;
            // skipped entirely when DATABASE_URL isn't configured (no
            // mirror to anchor idempotency).
            if (env.DATABASE_URL) {
              await ensureFreeSubscription({ env, sql: getDb(env) }, email)
            }
            return json(200, { email, tier: 'free', feeds: [] })
          }
          return json(401, { error: 'membership_not_found' })
        } catch (err) {
          console.error('[me] sc lookup failed:', err)
          const status = (err as ScError).status ?? 502
          json(status, { error: 'membership_lookup_failed' })
        }
      },
    },
    {
      // Newsletter preferences for the signed-in reader. GET returns current
      // mirror state from Neon (kept fresh by activation/cancel pushes and
      // the inbound Beehiiv webhook). PUT applies the requested change to
      // Beehiiv in one combined update, then refreshes the row.
      //
      // Toggles map to Beehiiv ops:
      //   free=true  → re-activate the subscription record (status=active)
      //   free=false → unsubscribe the whole record (premium issues stop too)
      //   premium=true  → require subscriber entitlement, then upgrade tier
      //   premium=false → downgrade tier to free
      path: '/api/me/newsletters',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'GET' && req.method !== 'PUT') {
          return json(405, { error: 'Method Not Allowed' })
        }

        // Require an Auth0 bearer (the checkout cookie carries no tier
        // claim, so premium toggles need a real session).
        const auth = req.headers.authorization
        if (!auth?.startsWith('Bearer ')) {
          return json(401, { error: 'unauthenticated' })
        }
        const profile = await verifyAuth0BearerProfile(auth.slice(7))
        if (!profile?.email) return json(401, { error: 'unauthenticated' })
        const email = profile.email

        // Tier from the JWT is the fast path. If it reads 'free' we double-
        // check Auth0 server-side — a member who upgraded after their last
        // login still has 'free' in their cached token and would otherwise
        // be denied premium toggles wrongly.
        let isMember = profile.tier === 'ark-plus-member'
        if (!isMember) {
          const live = await fetchAuth0TierForEmail(env, email)
          isMember = live === 'ark-plus-member'
        }

        if (!env.DATABASE_URL) {
          return json(500, { error: 'database_not_configured' })
        }
        const sql = getDb(env)
        const deps = { env, sql }

        if (req.method === 'GET') {
          const row = await refreshSubscriptionFromBeehiiv(deps, email)
          return json(200, {
            email,
            free: row ? isReceivingEmails(row.status) : false,
            premium: row?.hasPremium ?? false,
            canPremium: isMember,
          })
        }

        // PUT
        const wait = newsletterPrefsLimiter.take(email.toLowerCase())
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        const body = await readJson<{ free?: unknown; premium?: unknown }>(req)
        const setFree = typeof body?.free === 'boolean' ? body.free : undefined
        const setPremium =
          typeof body?.premium === 'boolean' ? body.premium : undefined
        if (setFree === undefined && setPremium === undefined) {
          return json(400, { error: 'no_changes' })
        }
        if (setPremium === true && !isMember) {
          return json(403, { error: 'not_entitled' })
        }

        // If the caller didn't touch the premium toggle but they're a member
        // re-activating the record (free flipping back on), include
        // premium:true so Beehiiv re-applies the tier on re-subscribe — this
        // closes the silent-premium-drop edge case.
        const prefs: { free?: boolean; premium?: boolean } = {}
        if (setFree !== undefined) prefs.free = setFree
        if (setPremium !== undefined) prefs.premium = setPremium
        if (setFree === true && setPremium === undefined && isMember) {
          prefs.premium = true
        }

        try {
          const updated = await applyPreferences(deps, email, prefs)
          json(200, {
            email,
            free: updated ? isReceivingEmails(updated.status) : false,
            premium: updated?.hasPremium ?? false,
            canPremium: isMember,
          })
        } catch (err) {
          console.error(
            `[me] newsletter preferences update failed for ${redactEmail(email)}:`,
            err,
          )
          json(502, { error: 'beehiiv_update_failed' })
        }
      },
    },
  ]
}
