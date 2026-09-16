// Beehiiv private podcast feeds — the paid member's Ark+ feed.
//
// A member holds one private feed per PREMIUM SHOW, and the publication carries
// several. The premium set is discovered from Beehiiv rather than configured —
// see the note on premiumShowsCache — so a new premium show reaches members on
// its own.
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

// Every premium show on the publication — the set the arkPlus entitlement
// covers, and therefore the set of private feeds a member gets.
//
// DISCOVERED, not configured. This used to be a single env var naming one show,
// which quietly became wrong the day a second premium show was created: the
// member held four feeds upstream and the app read one. Beehiiv answers the
// question directly, so asking it beats maintaining a list — a new premium show
// reaches members without a deploy or an env change.
//
// The signal is `private_feeds/by_email`, which is explicit and does not depend
// on which email is asked:
//   422 SHOW_IS_PUBLIC  → not a premium show
//   200                 → premium, and this member has a feed
//   404                 → premium, but no feed for this member (free, or not
//                         yet minted). NOT a classification signal on its own.
// `platform_links` correlates too (present on public shows, absent on premium),
// but that is an inference from a missing key; the 422 is Beehiiv saying it.
const PREMIUM_SHOWS_TTL_MS = 10 * 60_000
const premiumShowsCache = makeTTLCache<string, string[]>(PREMIUM_SHOWS_TTL_MS)

/** Resets the discovered premium-show set (unit tests only). */
export function clearPremiumShowCache(): void {
  premiumShowsCache.clear()
}

type PodcastListResponse = {
  data?: Array<{ id?: string; status?: string }>
}

// Every live show on the publication, premium or not. `status` filters out
// drafts: a show nobody can listen to yet has no business appearing in a
// member's setup list, feed or no feed.
async function listLiveShowIds(env: Env, pubId: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      `https://api.beehiiv.com/v2/publications/${pubId}/podcasts?limit=100`,
      { headers: { Authorization: `Bearer ${env.BEEHIIV_API_KEY}`, Accept: 'application/json' } },
    )
    if (!res.ok) {
      console.error(`[beehiiv-feeds] podcast list ${res.status}: ${await res.text()}`)
      return []
    }
    const body = (await res.json()) as PodcastListResponse
    return (body.data ?? [])
      .filter((p) => typeof p.id === 'string' && p.status === 'live')
      .map((p) => p.id as string)
  } catch (err) {
    console.error('[beehiiv-feeds] podcast list failed:', err)
    return []
  }
}

// `/api/me` runs on every page load, so a per-member upstream call needs a
// floor. Measured 290–390ms warm / ~950ms cold against the live API — small
// next to the episode list, but not free.
//
// Only an ANSWER is cached — a feed, or a public show. A `none` read is not;
// see the note at the cache write.
const FEED_CACHE_TTL_MS = 60_000
const feedCache = makeTTLCache<string, { read: FeedRead }>(FEED_CACHE_TTL_MS)

/** Resets the process-global feed cache (unit tests only). */
export function clearPrivateFeedCache(): void {
  feedCache.clear()
}

/**
 * One read of `private_feeds/by_email`, classified.
 *
 * The three outcomes are kept apart because the caller needs them apart:
 * `public` is a fact about the SHOW (and is how the premium set is discovered),
 * while `none` is a fact about this member. Collapsing them — as this module
 * did while there was only one configured show — makes it impossible to tell a
 * public show from an entitled member with no feed.
 *
 * Throws nothing. A network error or 5xx logs and reports `none`: entitlement
 * comes from Neon, so no membership decision may depend on Beehiiv answering.
 */
type FeedRead =
  | { kind: 'feed'; feed: PrivateFeed }
  | { kind: 'public' }
  | { kind: 'none' }

async function readPrivateFeed(
  env: Env,
  email: string,
  podcastId: string,
): Promise<FeedRead> {
  const token = env.BEEHIIV_API_KEY
  const pubId = publicationIdFromEnv(env)
  if (!token || !pubId) return { kind: 'none' }

  const cacheKey = `${pubId}:${podcastId}:${email.toLowerCase()}`
  const cached = feedCache.get(cacheKey)
  if (cached) return cached.read

  const url =
    `https://api.beehiiv.com/v2/publications/${pubId}` +
    `/podcasts/${podcastId}/private_feeds/by_email/${encodeURIComponent(email)}`

  let read: FeedRead = { kind: 'none' }
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.status === 422) {
      // SHOW_IS_PUBLIC. Expected while classifying — most shows on the
      // publication are public — so it is the CALLER that decides whether this
      // is news. An unexpected one (a show we had already classified premium)
      // means the premium toggle went off, and fetchPrivateFeeds logs it.
      await res.text()
      read = { kind: 'public' }
    } else if (res.status === 404) {
      // No feed for this member on a premium show: free, or not yet minted.
      read = { kind: 'none' }
    } else if (!res.ok) {
      console.error(
        `[beehiiv-feeds] feed lookup ${res.status} for ${redactEmail(email)}: ${await res.text()}`,
      )
    } else {
      const body = (await res.json()) as FeedApiResponse
      const d = body.data
      if (d?.id && d.url) {
        read = {
          kind: 'feed',
          feed: {
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
          },
        }
      }
    }
  } catch (err) {
    console.error(`[beehiiv-feeds] feed lookup failed for ${redactEmail(email)}:`, err)
  }

  // A `none` read is deliberately NOT cached. It is the answer for an entitled
  // member whose feed Beehiiv hasn't minted yet, and Beehiiv mints
  // ASYNCHRONOUSLY: measured on a live signup 2026-09-15, the premium tier
  // landed at 12:03:39Z (beehiiv_subscription.premium_since) and all four feeds
  // were created at 12:04:14Z — 35 seconds later. A member who has just paid is
  // on the setup page inside that window, so the first read is a 404, and
  // holding it for 60s is what kept "No private feeds on your membership yet"
  // on screen through the next reload as well. The setup page polls while it
  // holds no feeds, so this read has to be able to change its mind.
  //
  // The cost is bounded: only a member with no feed re-probes, the page paces
  // those probes, and entitlement never depended on this answer anyway.
  if (read.kind !== 'none') feedCache.set(cacheKey, { read })
  return read
}

/**
 * Every private feed this member holds, across every premium show.
 *
 * One membership, many feeds: the Beehiiv "Plus" tier entitles a member to all
 * of them, and Beehiiv mints a feed per (show, member) without being asked. The
 * shows are discovered on the way past — a cold cache probes every live show on
 * the publication and remembers which ones answered anything but 422, so the
 * classification costs nothing beyond the reads we wanted anyway.
 *
 * Returns [] rather than throwing on any failure, for the same reason
 * readPrivateFeed does: Neon decides entitlement, this only reports.
 */
export async function fetchPrivateFeeds(
  env: Env,
  email: string,
): Promise<PrivateFeed[]> {
  const pubId = publicationIdFromEnv(env)
  if (!env.BEEHIIV_API_KEY || !pubId) return []

  const known = premiumShowsCache.get(pubId)
  const candidates = known ?? (await listLiveShowIds(env, pubId))
  if (candidates.length === 0) return []

  const reads = await Promise.all(
    candidates.map((id) => readPrivateFeed(env, email, id)),
  )

  // A show we already believed was premium answering 422 is a configuration
  // alarm, not a discovery: every entitled member has silently lost that feed.
  // On a cold pass it is just how public shows announce themselves.
  const premium = candidates.filter((id, i) => {
    if (reads[i]!.kind !== 'public') return true
    if (known) {
      console.error(
        `[beehiiv-feeds] show ${id} now reports SHOW_IS_PUBLIC — premium toggle off?`,
      )
    }
    return false
  })
  premiumShowsCache.set(pubId, premium)

  return reads.flatMap((r) => (r.kind === 'feed' ? [r.feed] : []))
}

/**
 * The premium show set alone, for callers that need the universe rather than
 * one member's feeds (the reminder crons, which report "N of M set up").
 *
 * Needs an email only because the 422 signal rides on a by-email read; any
 * address answers the same, since the classification is a fact about the show.
 */
export async function premiumShowIds(env: Env, email: string): Promise<string[]> {
  const pubId = publicationIdFromEnv(env)
  if (!pubId) return []
  const known = premiumShowsCache.get(pubId)
  if (known) return known
  await fetchPrivateFeeds(env, email)
  return premiumShowsCache.get(pubId) ?? []
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
// Same credential, one fewer click.
//
// ⚠ `redirect_path` CANNOT LEAVE BEEHIIV, whatever their docs say. It is a path
// on the publication's own beehiiv domain, and an absolute URL is silently
// collapsed to "/" — so the member ends the round trip on
// `https://arkmedia.beehiiv.com/?connected=spotify`, not on us.
//
// Measured 2026-09-14, not inferred. `/authorize` 302s to Spotify with the
// value sealed inside the encrypted `state` blob, and the ciphertext length
// gives it away: a baseline of 545 bytes plus 19 bytes of framing plus the
// STORED path. `/x` → 566 (19+2), `/account/podcast-feed?spotify=linked` → 600
// (19+36, query and even a #fragment kept verbatim), while absolute URLs of 41,
// 56 and 246 chars ALL → 565 (19+1, i.e. "/"). `//host/p`, `http://host/p` and
// `https:/host/p` collapse the same way, and a bare `host/p` is kept with a "/"
// PREPENDED — it only ever builds a same-host path. Re-run the probe before
// believing any claim that this now works.
//
// We keep passing our own URL: it costs nothing today and starts working the
// day Beehiiv honours it. Nothing depends on the round trip — the setup page
// opens this in a NEW TAB and confirms from its own state.

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
