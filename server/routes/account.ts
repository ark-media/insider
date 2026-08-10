// Member profile — currently just the name.
//
// Names live on the Auth0 user (`given_name`/`family_name`), not in Neon: the
// membership table is deliberately an opaque ledger keyed on the Auth0 `sub`
// with no PII (migrations/0010_membership.sql), and a name is PII. Auth0 is
// already the identity store and already held these fields, so it's the honest
// home rather than a new column.
//
// Two reads exist by design. The Login Action mirrors the name into the access
// token, so the session cookie can answer /api/me for free — but that only
// refreshes at login, which would leave a member who was just backfilled (or who
// just typed their name on another device) staring at a stale greeting. So the
// account page reads through to Auth0 here, where the traffic is low and being
// authoritative is worth one Management call. /api/me stays claim-only.

import { getSessionProfile, resolveRequestIdentity, signSessionToken } from '../lib/session.js'
import { getAuth0NameProfile, updateAuth0Name } from '../lib/auth0-user.js'
import { setSessionCookies } from '../lib/cookies.js'
import { getDb } from '../lib/db.js'
import { syncSubscriberName, tryPush } from '../lib/beehiiv-sync.js'
import { isSameOrigin, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import {
  MAX_NAME_PART_LEN,
  displayName,
  hasRealName,
} from '../../shared/profile-name.js'

// Reads hit the Management API, so bound them per member. 30 with a 1-per-2s
// refill is far above a human opening the account page and well under Auth0's
// own rate limit.
const profileReadLimiter = createRateLimiter({ capacity: 30, refillPerSec: 1 / 2 })

// Writes fan out to Auth0 and Beehiiv; 10 saves per minute is more than anyone
// will click, matching the newsletter-preferences bucket.
const profileWriteLimiter = createRateLimiter({ capacity: 10, refillPerSec: 1 / 6 })

// Control characters (and newlines) have no place in a name and would corrupt
// an email header or a CSV export downstream.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/u

type NameError = 'invalid_name'

function cleanNamePart(raw: unknown): string | NameError | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return 'invalid_name'
  // Check before collapsing whitespace: `\s+` would quietly rewrite an embedded
  // newline into a space, turning a header-injection attempt into a plausible
  // name we'd then store. Reject it outright instead.
  if (CONTROL_CHARS.test(raw)) return 'invalid_name'
  const value = raw.trim().replace(/ +/g, ' ')
  if (!value) return null
  if (value.length > MAX_NAME_PART_LEN) return 'invalid_name'
  return value
}

export function accountRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/account/profile',
      method: ['GET', 'PUT'],
      handler: async (req, res, json) => {
        const isWrite = req.method === 'PUT'
        // State-changing + cookie-authenticated → reject cross-origin writes.
        if (isWrite && !isSameOrigin(req, appBaseUrl)) {
          return json(403, { error: 'bad_origin' })
        }

        const identity = await resolveRequestIdentity(req, env)
        // A checkout-token session has no Auth0 user to read or write yet.
        if (!identity?.sub) return json(401, { error: 'unauthenticated' })
        const sub = identity.sub

        const limiter = isWrite ? profileWriteLimiter : profileReadLimiter
        const wait = limiter.take(sub)
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        // Personal, and it changes the moment the member saves.
        res.setHeader('cache-control', 'private, no-store')

        if (!isWrite) {
          const profile = await getAuth0NameProfile(env, sub)
          if (!profile) return json(502, { error: 'profile_unavailable' })
          const email = profile.email ?? identity.email
          return json(200, {
            givenName: profile.givenName,
            familyName: profile.familyName,
            needsName: !hasRealName({ ...profile, email }),
          })
        }

        const body = await readJson<{ given_name?: unknown; family_name?: unknown }>(req)
        const given = cleanNamePart(body?.given_name)
        const family = cleanNamePart(body?.family_name)
        // A first name is required; a surname is optional, because mononyms are
        // real and a blocked save is worse than a partial name.
        if (given === 'invalid_name' || family === 'invalid_name' || !given) {
          return json(400, { error: 'invalid_name' })
        }
        const familyName = family === null ? '' : family

        const saved = await updateAuth0Name(env, sub, {
          givenName: given,
          familyName,
        })
        // Auth0 rejects root-attribute writes on a provider-controlled identity.
        // Say so rather than reporting a save that didn't happen.
        if (!saved) return json(502, { error: 'profile_not_writable' })

        // The name claim only refreshes at login, so re-mint the cookie or the
        // member's own greeting would lag their edit by up to the session TTL.
        // Bearer-authenticated callers have no cookie to re-mint.
        const session = await getSessionProfile(req, env)
        if (session) {
          const next = {
            ...session,
            givenName: given,
            familyName: familyName || undefined,
            name: displayName({
              givenName: given,
              familyName,
              email: identity.email,
            }),
          }
          setSessionCookies(res, await signSessionToken(next, env), env)
        }

        // Campaign personalization is the whole point, but a Beehiiv hiccup must
        // not fail a save the member can see succeeded in Auth0.
        if (env.DATABASE_URL) {
          await tryPush('profile name sync', () =>
            syncSubscriberName({ env, sql: getDb(env) }, identity.email, {
              first: given,
              last: familyName,
            }),
          )
        }

        return json(200, {
          givenName: given,
          familyName: familyName || null,
          needsName: false,
        })
      },
    }),
  ]
}
