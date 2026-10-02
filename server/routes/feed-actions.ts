// Member-initiated actions on their own private feed.
//
// Two things a member can do
// from the setup page that need a server:
//
//   POST /api/me/feeds/email    — ask Beehiiv to email them the feed + setup
//                                 instructions. Beehiiv owns this transactional
//                                 email, so there is no template of ours to
//                                 keep in sync, and no Twilio bill.
//   GET  /api/me/feeds/spotify  — hand off to Spotify Open Access.
//
// The Spotify hand-off exists because Open Access verifies that the click
// originated on Beehiiv's own page: we cannot link a member straight at
// Spotify. So we mint Beehiiv's auto-login server-side and 302 the member into
// Beehiiv's `/oauth/spotify/authorize`, which runs the consent flow and then
// sends them back to `/account/podcast-feed?spotify=linked`. The setup page
// opens this in the same tab so that return lands in front of them.
//
// Both are cookie-authenticated mutations of a sort, so both carry the
// same-origin guard and a per-member budget.

import {
  buildSpotifyHandoff,
  fetchPrivateFeeds,
  publicationIdFromEnv,
} from '../lib/beehiiv-feeds.js'
import { redactEmailsInText } from '../lib/beehiiv-status.js'
import { refreshSubscriptionFromBeehiiv } from '../lib/beehiiv-sync.js'
import { getDb } from '../lib/db.js'
import { resolveMembership } from '../lib/entitlement-resolver.js'
import { fetchWithTimeout, isSameOrigin, readJson } from '../lib/http.js'
import { createSharedRateLimiter } from '../lib/shared-rate-limit.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { redactEmail } from '../../shared/validation.js'

// Shared (Neon-backed) buckets, not in-process ones: each send is a real email
// from Beehiiv, and a per-instance bucket is multiplied by however many
// instances a script fans out across and refilled by every cold start. The
// bucket state lives in the database, so building the limiter per route table
// does not reset it.
//
// Beehiiv sends the mail. Still an email to a real inbox on a click: 3/hour.
const EMAIL_LIMIT = { name: 'feed-email', capacity: 3, refillPerSec: 3 / (60 * 60) }

// The hand-off mints a 30-minute credential each time. Cheap, but not something
// to allow in a loop.
const SPOTIFY_LIMIT = { name: 'feed-spotify', capacity: 10, refillPerSec: 1 / 30 }

// The Spotify hand-off is a top-level GET navigation, which carries no Origin
// header — so isSameOrigin (which passes a request without one) guards nothing
// there. Fetch Metadata does: browsers stamp every navigation with
// `sec-fetch-site`. 'same-origin' is the setup page's own link; 'none' is a
// user-initiated navigation (typed, bookmarked, reopened). 'cross-site' and
// 'same-site' are links on someone else's page — refused, as is a request
// with no header at all (not a browser we hand a credential to).
function isOwnNavigation(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header
  return value === 'same-origin' || value === 'none'
}

export function feedActionRoutes({ env, appBaseUrl, stripe }: Deps): Route[] {
  const emailLimiter = createSharedRateLimiter(env, EMAIL_LIMIT)
  const spotifyLimiter = createSharedRateLimiter(env, SPOTIFY_LIMIT)
  return [
    defineRoute({
      path: '/api/me/feeds/email',
      method: 'POST',
      handler: async (req, res, json) => {
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })

        // `emailFallback` matters here, not just `stripe`: the fallback only
        // runs when BOTH are set. A member who has paid but not yet logged in
        // through Auth0 carries a session with no `sub` (checkout mints it
        // before provisioning stamps one), so the Neon-by-sub read misses and
        // they resolve to 'free'. /api/me resolves the same caller as bundle
        // and renders these buttons — without this the page offers a member
        // something the route behind it refuses with not_entitled.
        const resolved = await resolveMembership(req, env, {
          emailFallback: true,
          stripe,
        })
        if (!resolved) return json(401, { error: 'unauthenticated' })
        if (!resolved.entitlements.arkPlus) return json(403, { error: 'not_entitled' })
        const email = resolved.identity.email

        const wait = await emailLimiter.take(email.toLowerCase())
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, {
            error: 'Too many requests. Please wait a bit and try again.',
          })
        }

        const pubId = publicationIdFromEnv(env)
        const token = env.BEEHIIV_API_KEY
        if (!pubId || !token) {
          return json(503, { error: 'feed_email_unavailable' })
        }

        // Which show to send. The setup page has a row per premium show, so the
        // id has to come from the click — but it is a caller-supplied id, so it
        // is checked against the member's OWN feeds rather than trusted. An
        // unknown id is 404, never a send for somebody else's show.
        const body = await readJson<{ show_id?: unknown }>(req)
        const requested = typeof body?.show_id === 'string' ? body.show_id : null
        const feeds = await fetchPrivateFeeds(env, email)
        if (feeds.length === 0) return json(409, { error: 'no_feed_yet' })
        const podcastId = requested
          ? feeds.find((f) => f.show.id === requested)?.show.id
          : // No id supplied and exactly one feed: unambiguous, so send it.
            // With several, silence is not a choice we get to make for them.
            feeds.length === 1
            ? feeds[0]!.show.id
            : null
        if (!podcastId) return json(404, { error: 'unknown_show' })

        try {
          const upstream = await fetchWithTimeout(
            `https://api.beehiiv.com/v2/publications/${pubId}/podcasts/${podcastId}` +
              `/private_feeds/by_email/${encodeURIComponent(email)}/emails`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'content-type': 'application/json',
              },
              body: '{}',
            },
          )
          // 404 = no feed token for this member yet. That is a provisioning
          // gap, not a bad request: report it as such rather than as success.
          if (upstream.status === 404) return json(409, { error: 'no_feed_yet' })
          if (!upstream.ok) {
            console.error(
              `[feed-actions] feed email ${upstream.status} for ${redactEmail(email)}: ${redactEmailsInText(await upstream.text())}`,
            )
            return json(502, { error: 'feed_email_failed' })
          }
          return json(200, { ok: true })
        } catch (err) {
          console.error(
            `[feed-actions] feed email failed for ${redactEmail(email)}:`,
            err,
          )
          return json(502, { error: 'feed_email_failed' })
        }
      },
    }),
    defineRoute({
      path: '/api/me/feeds/spotify',
      method: 'GET',
      handler: async (req, res, json) => {
        // A GET that redirects, so it is reachable as a plain link — but it
        // mints a credential, so a member must be arriving from our own page,
        // not from an off-site link. See isOwnNavigation.
        if (!isSameOrigin(req, appBaseUrl) || !isOwnNavigation(req.headers['sec-fetch-site'])) {
          return json(403, { error: 'bad_origin' })
        }

        const resolved = await resolveMembership(req, env, {
          emailFallback: true,
          stripe,
        })
        if (!resolved) return json(401, { error: 'unauthenticated' })
        if (!resolved.entitlements.arkPlus) return json(403, { error: 'not_entitled' })
        const email = resolved.identity.email

        const wait = await spotifyLimiter.take(email.toLowerCase())
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        if (!env.DATABASE_URL) return json(503, { error: 'spotify_unavailable' })

        // Beehiiv's JWT endpoint keys on the subscription id, and that id is
        // PER PUBLICATION. Read it back through the refresh rather than
        // straight out of the mirror: a row written before a publication move
        // still holds the OLD publication's subscription id, and minting
        // against the current publication with it fails with nothing in the
        // response to say why. The refresh re-resolves by email against the
        // configured publication and heals the row on the way past.
        const local = await refreshSubscriptionFromBeehiiv(
          { env, sql: getDb(env) },
          email,
        )
        if (!local) return json(409, { error: 'no_subscription' })

        // Where Beehiiv sends the member once Spotify has been linked. HTTPS
        // absolute URLs survive in `redirect_path` (see buildSpotifyHandoff);
        // the setup page is a same-tab hand-off and reads the `spotify` marker
        // on the way back.
        const handoff = await buildSpotifyHandoff(
          env,
          local.beehiivSubscriptionId,
          `${appBaseUrl}/account/podcast-feed?spotify=linked`,
        )
        if (!handoff) return json(503, { error: 'spotify_unavailable' })

        // The URL carries a live 30-minute credential for this member's Beehiiv
        // profile. Issue it as a redirect and never log it, cache it, or return
        // it as JSON where it could land in a browser history or an analytics
        // payload.
        res.setHeader('cache-control', 'private, no-store')
        res.statusCode = 302
        res.setHeader('location', handoff.url)
        res.end()
      },
    }),
  ]
}
