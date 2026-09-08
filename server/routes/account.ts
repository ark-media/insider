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

import { resolveRequestIdentity, signSessionToken } from '../lib/session.js'
import {
  getAuth0NameProfile,
  sendAuth0PasswordResetEmail,
  updateAuth0Name,
} from '../lib/auth0-user.js'
import { setSessionCookies } from '../lib/cookies.js'
import { getDb } from '../lib/db.js'
import { syncSubscriberName, tryPush } from '../lib/beehiiv-sync.js'
import { createScClient, updateScUserName } from '../lib/sc-client.js'
import { updateCircleMemberName } from '../entitlement.js'
import { isSameOrigin, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { MAX_NAME_PART_LEN, hasRealName } from '../../shared/profile-name.js'

// Reads hit the Management API, so bound them per member. 30 with a 1-per-2s
// refill is far above a human opening the account page and well under Auth0's
// own rate limit.
const profileReadLimiter = createRateLimiter({ capacity: 30, refillPerSec: 1 / 2 })

// Writes fan out to Auth0 and Beehiiv; 10 saves per minute is more than anyone
// will click, matching the newsletter-preferences bucket.
const profileWriteLimiter = createRateLimiter({ capacity: 10, refillPerSec: 1 / 6 })

// Password-reset requests send a real email to a real inbox, so this is the
// tightest bucket on the account routes: 3 with a 1-per-5-minute refill lets a
// member who didn't see the first one try again without turning the button into
// a way to flood their own mailbox.
const passwordResetLimiter = createRateLimiter({ capacity: 3, refillPerSec: 1 / 300 })

// Characters that have no place in a name and would corrupt an email header or
// a CSV export downstream: the C0/C1 controls, the Unicode line and paragraph
// separators, and the bidi marks/embeddings/overrides/isolates that can make one
// string display as another.
//
// Deliberately NOT the whole \p{Cf} category, which was the first cut: it also
// contains ZWNJ (U+200C) and ZWJ (U+200D), which are orthographically required
// in Persian, Hindi, Bengali and Malayalam names. Rejecting those hands a real
// member a flat 400 with nothing to correct.
const CONTROL_CHARS =
  /[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u

type NameError = 'invalid_name'

function cleanNamePart(raw: unknown): string | NameError | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return 'invalid_name'
  // Check before collapsing whitespace: `\s+` would quietly rewrite an embedded
  // newline into a space, turning a header-injection attempt into a plausible
  // name we'd then store. Reject it outright instead.
  if (CONTROL_CHARS.test(raw)) return 'invalid_name'
  // Fold every Unicode space separator to a plain one before collapsing — a name
  // pasted out of a word processor arrives with U+00A0, which is neither a
  // control character nor an ASCII space, and would otherwise be stored as-is
  // and then render inconsistently against the same name typed by hand.
  const value = raw.replace(/\p{Zs}/gu, ' ').trim().replace(/ +/g, ' ')
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
        // Needs an Auth0 user to read or write. A post-checkout token usually
        // carries one — signCheckoutToken stamps the sub as soon as provisioning
        // resolves it — so a buyer can set their name from /welcome before their
        // first login. They have no ark_session to re-mint below, so /api/me
        // keeps answering from the checkout token (which carries no name) until
        // they sign in; the account page reads Auth0 directly and is correct
        // immediately.
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

        // setByMember records that a human typed this. Without it a lowercase
        // first name matching the email local part ("sarah" for sarah@…) is
        // re-judged manufactured on the very next read, and the prompt they just
        // answered comes straight back — see shared/profile-name.
        const saved = await updateAuth0Name(
          env,
          sub,
          { givenName: given, familyName },
          { setByMember: true },
        )
        // Auth0 rejects root-attribute writes on a provider-controlled identity.
        // Say so rather than reporting a save that didn't happen.
        if (!saved) return json(502, { error: 'profile_not_writable' })

        // The name claim only refreshes at login, so re-mint the cookie or the
        // member's own greeting would lag their edit by up to the session TTL.
        // Present only for the ark_session credential — a bearer or checkout
        // caller has no cookie to re-mint. Already verified by
        // resolveRequestIdentity, so this doesn't re-parse it.
        const session = identity.session
        if (session) {
          const next = {
            ...session,
            givenName: given,
            familyName: familyName || undefined,
            nameSetByMember: true,
          }
          setSessionCookies(res, await signSessionToken(next, env), env)
        }

        // Every store that greets this member by name has to hear about the
        // edit, or the one left behind keeps sending the old value: Beehiiv
        // personalizes campaigns from its custom fields, Supporting Cast's
        // first_name is what the feed-setup reminder cron greets from, and
        // Circle shows the name to every other member — the one store where a
        // stale value is read by strangers rather than by us. Each is
        // soft-failed: none may sink a save the member can see succeeded in
        // Auth0.
        //
        // Started together and awaited once. They are independent of each other
        // and nothing below reads their results, so running them in series only
        // added their latencies together on a request the member is watching —
        // and Circle's push is two round trips on its own (search, then PUT).
        const pushes = [
          env.DATABASE_URL
            ? tryPush('profile name sync', () =>
                syncSubscriberName({ env, sql: getDb(env) }, identity.email, {
                  // null, not '': the member deleting their surname is a
                  // deliberate clear, and Beehiiv has to drop the field rather
                  // than keep merging the old one into every campaign.
                  first: given,
                  last: familyName || null,
                }),
              )
            : null,
          env.SC_API_KEY && env.SC_NETWORK_ID
            ? tryPush('profile name sync (sc)', () =>
                updateScUserName(createScClient(env), identity.email, {
                  first: given,
                  last: familyName,
                }),
              )
            : null,
          tryPush('profile name sync (circle)', () =>
            updateCircleMemberName(env, identity.email, {
              first: given,
              last: familyName || null,
            }),
          ),
        ].filter((p) => p !== null)
        await Promise.allSettled(pushes)

        return json(200, {
          givenName: given,
          familyName: familyName || null,
          needsName: false,
        })
      },
    }),

    defineRoute({
      // "Send me a reset link" from the account page's Settings tab. Auth0
      // sends its own branded email; we never see or set the password.
      //
      // Only meaningful for a database identity — a Google-only account has no
      // password, and Auth0 answers a change_password for one with a success it
      // didn't earn. /api/me gates the button on the same `auth0|` prefix, and
      // this re-checks it rather than trusting the client to have done so.
      path: '/api/account/password-reset',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })

        const identity = await resolveRequestIdentity(req, env)
        if (!identity?.sub) return json(401, { error: 'unauthenticated' })
        if (!identity.sub.startsWith('auth0|')) {
          return json(400, { error: 'not_password_account' })
        }

        const wait = passwordResetLimiter.take(identity.email.toLowerCase())
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        const sent = await sendAuth0PasswordResetEmail(identity.email, env)
        if (!sent) return json(502, { error: 'send_failed' })
        return json(200, { ok: true })
      },
    }),
  ]
}
