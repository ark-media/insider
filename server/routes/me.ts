// Whoami / personalized feeds. Returns the signed-in user's private Beehiiv
// feed so the SPA can render the setup page.

import { redactEmail } from '../../shared/validation.js'
import {
  fetchPrivateFeed,
  premiumPodcastIdFromEnv,
  type PrivateFeed,
} from '../lib/beehiiv-feeds.js'
import {
  applyPreferences,
  ensureFreeSubscription,
  isReceivingEmails,
  PremiumNotConfiguredError,
  refreshSubscriptionFromBeehiiv,
} from '../lib/beehiiv-sync.js'
import { deriveEntitlements, type Entitlements } from '../entitlement.js'
import { getDb } from '../lib/db.js'
import {
  resolveMembership,
  resolveRequestIdentity,
} from '../lib/entitlement-resolver.js'
import type { MembershipRow } from '../lib/membership.js'
import { getSetupStates, recordFeedsPending } from '../lib/feed-activations.js'
import { isSameOrigin, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'

// Per-axis access for account settings (T7.1): what the member has on each
// entitlement axis (Ark+ = arkPlus, the Fold = circle) and from what source —
// a live gift term shows its end date, a subscription shows its renewal (or
// cancel) date. Recipients are members with an expiry, not subscribers, so the
// UI must say what they hold and until when, per axis.
type AxisSource = 'subscription' | 'gift'
type AxisAccess = {
  active: boolean
  source: AxisSource | null
  expiresAt: string | null // gift term end, or a canceling subscription's cancel_at
  renewsAt: string | null // subscription renewal (current_period_end); null for gifts
}

// Attribute each active axis to its source using the membership row. A gifted
// axis on a paid-sub row (D5 grant) resolves to 'gift' with its own expiry; the
// subscription axis resolves to 'subscription'. Mirrors entitlement.ts liveAxes
// (subscription/comp base ∪ per-axis gift terms).
function computeAxes(
  row: MembershipRow | null,
  entitlements: Entitlements,
): { arkPlus: AxisAccess; circle: AxisAccess } {
  const now = Date.now()
  const axis = (key: 'arkPlus' | 'circle', giftExpiry: string | null): AxisAccess => {
    if (!entitlements[key]) {
      return { active: false, source: null, expiresAt: null, renewsAt: null }
    }
    if (row) {
      const hasGift =
        row.ark_plus_gift_expires_at != null || row.circle_gift_expires_at != null
      // A subscription row, or a comp/staff row (no sub, no gift), grants via tier.
      const subOrComp = row.stripe_subscription_id != null || !hasGift
      if (subOrComp && deriveEntitlements(row.tier)[key]) {
        return {
          active: true,
          source: 'subscription',
          expiresAt: row.cancel_at,
          renewsAt: row.current_period_end,
        }
      }
      if (giftExpiry != null && Date.parse(giftExpiry) > now) {
        return { active: true, source: 'gift', expiresAt: giftExpiry, renewsAt: null }
      }
    }
    // Row-less active axis: no membership row resolved it, so we can say it's
    // active but nothing about its source or dates.
    return { active: true, source: 'subscription', expiresAt: null, renewsAt: null }
  }
  return {
    arkPlus: axis('arkPlus', row?.ark_plus_gift_expires_at ?? null),
    circle: axis('circle', row?.circle_gift_expires_at ?? null),
  }
}

// Bucket the PUT route by normalized email so flapping toggles can't burn
// Beehiiv quota or rate-limit the upstream API. 10 saves per minute is more
// than any human will click; sustained refill is 1/6s.
const newsletterPrefsLimiter = createRateLimiter({
  capacity: 10,
  refillPerSec: 1 / 6,
})

// Bucket the optimistic setup marker by normalized email. A member setting up
// the whole network plus a few individual feeds fits well under 20 writes;
// sustained refill is 1/6s. Bounds an authenticated caller from scripting the
// endpoint to bloat beehiiv_feed_activations with junk pending rows.
const feedSetupLimiter = createRateLimiter({
  capacity: 20,
  refillPerSec: 1 / 6,
})

// A feed as returned to the SPA, plus the setup state we mirror server-side.
//
// `id` is the SHOW id, not the feed token — `pod_feed_<uuid>` rotates on
// reissue, and the client round-trips this id back through `?feed=` and the
// pending marker, so a rotation would orphan both. The token never leaves the
// server; the URL it appears in does.
//
// `activated` is authoritative — Beehiiv reports it on the feed itself and
// through the `podcasts.private_feed` webhook. `pending` is our optimistic
// marker, set when the member takes a setup action but the webhook hasn't
// landed yet. The setup page treats a feed as done if either is true.
type WireFeed = {
  id: string
  name: string
  url: string
  description?: string
  image_url?: string
  protocolLinks: Record<string, string>
  activated?: boolean
  activated_at?: string | null
  pending?: boolean
}

// Project a Beehiiv feed onto the wire shape. Keeps `name`/`image_url` as the
// client's field names — they now carry Beehiiv's own show title and artwork,
// which is deliberate: those same values go into the RSS the member's podcast
// app reads, so the site and the app agree without us hardcoding either.
function toWireFeed(feed: PrivateFeed): WireFeed {
  return {
    id: feed.show.id,
    name: feed.show.title,
    url: feed.url,
    ...(feed.show.description ? { description: feed.show.description } : {}),
    ...(feed.show.artworkUrl ? { image_url: feed.show.artworkUrl } : {}),
    protocolLinks: feed.protocolLinks,
  }
}

// Merge persisted setup state onto the feeds. Belt and braces: Beehiiv's own
// `activated` timestamp wins when present, so a missed webhook can't strand the
// display; the mirror supplies the optimistic `pending` marker the API has no
// concept of. Soft-fails — any DB error (or no DATABASE_URL) returns the live
// state alone, so a mirror outage degrades to "not set up yet" rather than
// breaking /api/me.
async function enrichFeedsWithActivation(
  env: Deps['env'],
  email: string,
  feeds: PrivateFeed[],
): Promise<WireFeed[]> {
  const wire = feeds.map((f) => {
    const w = toWireFeed(f)
    if (f.activatedAt != null && f.revokedAt == null) {
      w.activated = true
      w.activated_at = f.activatedAt
    }
    return w
  })
  if (!env.DATABASE_URL || wire.length === 0) return wire
  try {
    const states = await getSetupStates(getDb(env), email)
    if (states.size === 0) return wire
    return wire.map((w) => {
      const s = states.get(w.id)
      if (!s) return w
      return {
        ...w,
        activated: w.activated === true || s.activated,
        activated_at: w.activated_at ?? s.activatedAt,
        pending: s.pending,
      }
    })
  } catch (err) {
    console.error('[me] feed activation enrich failed:', err)
    return wire
  }
}

// True when the Auth0 primary identity is the database connection, i.e. the
// account has a password at all. Social identities are `google-oauth2|…`,
// `apple|…` and so on. A checkout-token session carries no sub, which is a
// "we don't know" — treated as "no password row" so we never offer a reset we
// can't stand behind.
function isDatabaseIdentity(sub: string | null): boolean {
  return typeof sub === 'string' && sub.startsWith('auth0|')
}

export function meRoutes({ env, appBaseUrl, stripe }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/me',
      handler: async (req, res, json) => {
        // Identity-scoped response (email/tier/entitlements/feeds) — must never
        // be cached by a shared proxy/CDN and served to another user.
        res.setHeader('cache-control', 'private, no-store')

        // Neon is the single entitlement authority (§3). The by-email fallback
        // still resolves a just-paid member whose session carries no sub yet.
        const resolved = await resolveMembership(req, env, { emailFallback: true, stripe })
        if (!resolved) return json(401, { error: 'unauthenticated' })
        const { identity, tier, entitlements } = resolved
        const email = identity.email
        // Per-axis access (source + expiry) for account settings — recipients are
        // members-with-an-expiry, not subscribers, so the UI needs per-axis facts.
        const axes = computeAxes(resolved.row, entitlements)

        // A checkout-token holder (just paid) with no resolved entitlement is a
        // provisioning gap, not a free user — keep the 401 so the client keeps
        // polling until the webhook finishes provisioning.
        if (tier === 'free' && identity.source === 'checkout') {
          return json(401, { error: 'membership_not_found' })
        }

        // Render the private feed for the arkPlus axis, keyed on the session
        // email (Beehiiv has no id of ours to key on). `fetchPrivateFeed` never
        // throws and returns null for every "no feed" case, so a Beehiiv outage
        // degrades to an empty list — entitlement came from Neon, and the
        // membership decision must never depend on Beehiiv being reachable.
        const podcastId = premiumPodcastIdFromEnv(env)
        const feeds: PrivateFeed[] = []
        if (entitlements.arkPlus && podcastId) {
          const feed = await fetchPrivateFeed(env, email, podcastId)
          if (feed) feeds.push(feed)
        }
        const enriched = await enrichFeedsWithActivation(env, email, feeds)

        // First-login auto-subscribe to the free newsletter for a logged-in free
        // reader. Soft-fails internally so a Beehiiv outage can't block login;
        // skipped without DATABASE_URL (no mirror to anchor idempotency).
        if (tier === 'free' && env.DATABASE_URL) {
          await ensureFreeSubscription({ env, sql: getDb(env) }, email)
        }

        return json(200, {
          email,
          // Null whenever no real name is held — the client greets by this or
          // falls back, and must never show the email as a name.
          firstName: identity.firstName,
          tier,
          entitlements,
          axes,
          // Whether a "change your password" action means anything for this
          // account. A member who signs in with Google has no password to
          // change, and offering one sends them to a reset email for
          // credentials they've never had. The primary `sub`'s connection
          // prefix is the authority: `auth0|` is the database connection, and
          // a merged identity whose primary is `auth0|` genuinely does hold a
          // password even if they habitually click "Sign in with Google".
          passwordResettable: isDatabaseIdentity(identity.sub),
          feeds: enriched,
        })
      },
    }),
    defineRoute({
      // Optimistic "I've set up these feeds" marker. The client calls this the
      // moment a member takes a setup action (opens a deep link, copies the
      // feed URL, texts themselves the link, or links Spotify for the whole
      // network), so the setup hub shows the feed as done immediately and
      // across devices — the server-side replacement for the old localStorage
      // marker. Beehiiv's `podcasts.private_feed` webhook remains
      // authoritative and reconciles the row later.
      path: '/api/me/feeds/setup',
      method: 'POST',
      handler: async (req, res, json) => {
        // State-changing + cookie-authenticated → reject cross-origin posts.
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })

        // Resolve the member email the same way every other gate does — one
        // shared resolver over all accepted credentials (Auth0 bearer, checkout
        // token by bearer or cookie, ark_session login cookie). A just-paid
        // member on the setup page may only hold the checkout cookie; the
        // resolver accepts it.
        const email = (await resolveRequestIdentity(req, env))?.email ?? null
        if (!email) return json(401, { error: 'unauthenticated' })

        const wait = feedSetupLimiter.take(email.toLowerCase())
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        // No DB → nothing to persist. The client's optimistic in-memory state
        // still stands and the webhook remains the source of truth, so ack.
        if (!env.DATABASE_URL) return json(200, { ok: true })

        // Show ids (`pod_<uuid>`), not the rotating feed token — see WireFeed.
        // Bounded length as well as shape: an authenticated caller must not be
        // able to script this endpoint into bloating the mirror with junk rows.
        const body = await readJson<{ feed_ids?: unknown }>(req)
        const showIds = Array.isArray(body?.feed_ids)
          ? body.feed_ids
              .filter(
                (v): v is string =>
                  typeof v === 'string' && v.length > 0 && v.length <= 64,
              )
              .slice(0, 100)
          : []
        if (showIds.length === 0) return json(400, { error: 'no_feed_ids' })

        try {
          await recordFeedsPending(getDb(env), email, showIds)
          json(200, { ok: true })
        } catch (err) {
          console.error('[me] feed pending write failed:', err)
          json(500, { error: 'pending_write_failed' })
        }
      },
    }),
    defineRoute({
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
      method: ['GET', 'PUT'],
      handler: async (req, res, json) => {
        if (req.method === 'PUT' && !isSameOrigin(req, appBaseUrl)) {
          return json(403, { error: 'bad_origin' })
        }

        // Neon decides premium eligibility (task 11): the premium newsletter
        // rides the arkPlus axis. A member who upgraded after their last login
        // is never stale here — the row is read live, keyed on their sub, with
        // the by-email net covering a not-yet-written row.
        const resolved = await resolveMembership(req, env, { emailFallback: true, stripe })
        if (!resolved) return json(401, { error: 'unauthenticated' })
        const email = resolved.identity.email
        const isMember = resolved.entitlements.arkPlus

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
          if (err instanceof PremiumNotConfiguredError) {
            console.error(`[me] premium toggle unavailable for ${redactEmail(email)}: no tier configured`)
            return json(503, { error: 'premium_unavailable' })
          }
          console.error(
            `[me] newsletter preferences update failed for ${redactEmail(email)}:`,
            err,
          )
          json(502, { error: 'beehiiv_update_failed' })
        }
      },
    }),
  ]
}
