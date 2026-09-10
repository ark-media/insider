// Beehiiv private podcast feeds — the paid member's Ark+ feed.
//
// One premium show, so a member has at most one private feed, but the read is
// per (podcast, email) so a second premium show is a config change rather than
// a rewrite.
//
// ⚠ EMAIL IS THE KEY. Beehiiv keys a feed on the email itself, and
// `beehiiv_subscription`'s primary key is the email too. There is no
// email-change flow in the app today, so nothing is broken — but whoever adds
// one must move the Beehiiv subscription in the same transaction, or the
// member's feed silently vanishes with no error anywhere.
//
// Read-only: Beehiiv exposes no endpoint that mints a feed token. The token is
// minted upstream when the premium tier is applied (see
// `ensureSubscribedWithPremium` in beehiiv-sync.ts), which is why provisioning
// lives there and this module only reads the result.

import { makeTTLCache } from '../../shared/ttl-cache.js'
import { redactEmail } from '../../shared/validation.js'
import { fetchWithTimeout } from './http.js'

type Env = Record<string, string | undefined>

// The private feed as the SPA needs it. `protocolLinks` are Beehiiv's
// app-specific deep links (apple / castro / overcast / pocket_casts — the
// complete set; there is no Spotify or YouTube Music link, Spotify goes
// through the JWT hand-off instead).
export type PrivateFeed = {
  /** `pod_feed_<uuid>`. ROTATES on reissue — never key persisted state on it. */
  id: string
  url: string
  protocolLinks: Record<string, string>
  activatedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  show: {
    id: string
    title: string
    description: string | null
    artworkUrl: string | null
  }
}

type FeedApiResponse = {
  data?: {
    id?: string
    url?: string
    protocol_links?: Record<string, unknown>
    created?: number | null
    activated?: number | null
    revoked?: number | null
    expires?: number | null
    show?: {
      id?: string
      title?: string
      description?: string | null
      artwork_url?: string | null
    }
  }
}

// Beehiiv reports feed timestamps as unix SECONDS (nullable except `created`).
// `toIsoDate` in ./dates.ts deliberately truncates to a calendar date; an
// activation is an instant, so keep the full ISO string.
function toIsoInstant(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  const d = new Date(seconds * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function toStringMap(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string' && v) out[k] = v
  }
  return out
}

export function publicationIdFromEnv(env: Env): string | null {
  const id =
    env.BEEHIIV_PUBLICATION_ID_ARK_DAILY || env.BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER
  if (!id || !/^pub_[A-Za-z0-9-]+$/.test(id)) return null
  return id
}

// The one premium show. Its own env var rather than the slug-derived lookup in
// routes/podcasts.ts, because that map is for public shows and this id is the
// entitlement's subject.
export function premiumPodcastIdFromEnv(env: Env): string | null {
  const id = env.BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK
  if (!id || !/^pod_[A-Za-z0-9-]+$/.test(id)) return null
  return id
}

// `/api/me` runs on every page load, so a per-member upstream call needs a
// floor. Measured 290–390ms warm / ~950ms cold against the live API — small
// next to the episode list, but not free. 60s is short enough that a
// just-provisioned feed appears on the member's next reload.
const FEED_CACHE_TTL_MS = 60_000
const feedCache = makeTTLCache<string, { feed: PrivateFeed | null }>(FEED_CACHE_TTL_MS)

/** Resets the process-global feed cache (unit tests only). */
export function clearPrivateFeedCache(): void {
  feedCache.clear()
}

/**
 * The member's private feed for one premium show, or null when they have none.
 *
 * Null covers every "no feed" case deliberately: both 404 variants (no
 * subscriber at all, and a subscriber who exists but isn't premium) differ only
 * in message text, so branching on the message would be brittle. Our own Neon
 * entitlement decides whether "no feed" is expected; this only reports.
 *
 * Throws nothing. A network error or 5xx logs and returns null — entitlement
 * came from Neon, so the membership decision never depends on Beehiiv being
 * reachable.
 */
export async function fetchPrivateFeed(
  env: Env,
  email: string,
  podcastId: string,
): Promise<PrivateFeed | null> {
  const token = env.BEEHIIV_API_KEY
  const pubId = publicationIdFromEnv(env)
  if (!token || !pubId) return null

  const cacheKey = `${pubId}:${podcastId}:${email.toLowerCase()}`
  const cached = feedCache.get(cacheKey)
  if (cached) return cached.feed

  const url =
    `https://api.beehiiv.com/v2/publications/${pubId}` +
    `/podcasts/${podcastId}/private_feeds/by_email/${encodeURIComponent(email)}`

  let feed: PrivateFeed | null = null
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.status === 404) {
      feed = null
    } else if (res.status === 422) {
      // SHOW_IS_PUBLIC — the podcast isn't premium. That is a configuration
      // alarm, not a member state: every entitled member silently loses their
      // feed until someone re-checks the dashboard. Log loudly.
      console.error(
        `[beehiiv-feeds] 422 for podcast ${podcastId} — is the premium toggle off? ${await res.text()}`,
      )
      feed = null
    } else if (!res.ok) {
      console.error(
        `[beehiiv-feeds] feed lookup ${res.status} for ${redactEmail(email)}: ${await res.text()}`,
      )
      feed = null
    } else {
      const body = (await res.json()) as FeedApiResponse
      const d = body.data
      if (d?.id && d.url) {
        feed = {
          id: d.id,
          url: d.url,
          protocolLinks: toStringMap(d.protocol_links),
          activatedAt: toIsoInstant(d.activated),
          revokedAt: toIsoInstant(d.revoked),
          expiresAt: toIsoInstant(d.expires),
          show: {
            id: d.show?.id ?? podcastId,
            title: d.show?.title ?? '',
            description: d.show?.description ?? null,
            artworkUrl: d.show?.artwork_url ?? null,
          },
        }
      }
    }
  } catch (err) {
    console.error(`[beehiiv-feeds] feed lookup failed for ${redactEmail(email)}:`, err)
    feed = null
  }

  feedCache.set(cacheKey, { feed })
  return feed
}

// --- Spotify hand-off -----------------------------------------------------

// Spotify Open Access verifies that the click originated on Beehiiv's own
// page, so we cannot link a member straight at Spotify's auth URL. Beehiiv's
// answer (confirmed by their team, 2026-09-10) is a purpose-built entry point:
// mint an auto-login server-side and send the member to
// `/oauth/spotify/authorize`, which drops them straight into Spotify's consent
// screen and then returns them to a URL we nominate.
//
// This replaced an earlier hand-off that landed on Beehiiv's per-show "Add to
// podcast app" page and left the member to find the Spotify button themselves.
// Same credential, one fewer click, and — because of `redirect_path` — the
// round trip now ends back on our own setup page instead of stranding them on
// Beehiiv.

export type SpotifyHandoff = { url: string; subscriberId: string }

type JwtResponse = { data?: { jwt_token?: string } }

// The JWT payload carries `subscriber_id`, which is a DIFFERENT uuid from the
// `sub_…` subscription id — and it is the one every subscriber-facing Beehiiv
// URL wants. Passing the subscription id renders a broken page reading "You do
// not have access to the subscriber's data". Reading it out of the token saves
// a second API call.
function subscriberIdFromJwt(jwt: string): string | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const json = Buffer.from(part, 'base64url').toString('utf8')
    const id = (JSON.parse(json) as { subscriber_id?: unknown }).subscriber_id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * Mint a Beehiiv auto-login and build the URL that starts the Spotify Open
 * Access link for this member, returning them to `returnUrl` when it finishes.
 *
 * The returned URL carries a 30-minute credential for that member's Beehiiv
 * profile: issue it as a 302 and never log it, cache it, or hand it to the
 * client as JSON. Beehiiv scopes each token to a single write action, so mint
 * one per click — there is nothing here worth caching.
 *
 * Note this is deliberately not built on the subscriber profile URL. That page
 * exposes "Cancel paid subscription", which would drop the Beehiiv premium
 * tier while our Stripe subscription kept billing.
 */
export async function buildSpotifyHandoff(
  env: Env,
  subscriptionId: string,
  returnUrl: string,
): Promise<SpotifyHandoff | null> {
  const token = env.BEEHIIV_API_KEY
  const pubId = publicationIdFromEnv(env)
  const host = env.BEEHIIV_SUBSCRIBER_HOST
  if (!token || !pubId || !host) return null

  try {
    const res = await fetchWithTimeout(
      `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions/${subscriptionId}/jwt_token`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    )
    if (!res.ok) {
      // 422 "JWT token fetching not allowed" means auto-login is switched off
      // for the publication — a setting, not a member state.
      console.error(`[beehiiv-feeds] jwt mint ${res.status}: ${await res.text()}`)
      return null
    }
    const jwt = ((await res.json()) as JwtResponse).data?.jwt_token
    if (!jwt) return null
    const subscriberId = subscriberIdFromJwt(jwt)
    if (!subscriberId) {
      console.error('[beehiiv-feeds] jwt payload carried no subscriber_id')
      return null
    }
    const params = new URLSearchParams({
      subscriber_id: subscriberId,
      jwt_token: jwt,
      redirect_path: returnUrl,
    })
    return {
      subscriberId,
      url: `https://${host}/oauth/spotify/authorize?${params.toString()}`,
    }
  } catch (err) {
    console.error('[beehiiv-feeds] jwt mint failed:', err)
    return null
  }
}
