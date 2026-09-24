import type { NewsletterSlug } from "../data/newsletters.js";
import type { ListenLink, ShowSlug } from "../data/shows.js";

/**
 * Single source of truth for every brand-owned and external URL the site
 * links out to. If a URL points at an Ark Media property or a third-party
 * profile/app, it belongs here — not inline in a component or data file.
 *
 * Intentionally NOT here (they're infra/SDK bases, env-driven or framework
 * config, and change per environment rather than per brand):
 *   - PostHog host            → VITE_POSTHOG_HOST (src/lib/observability.ts)
 *   - YouTube embed base      → src/routes/israel-votes.tsx
 *   - Google Fonts            → index.html
 * Per-episode media URLs (audio, thumbnails) also stay with their data,
 * since episode data is fetched from Beehiiv at runtime.
 *
 * TODO(ark): values marked PLACEHOLDER need a real Ark Media URL before launch.
 */

// ---------------------------------------------------------------------------
// Social profiles
// ---------------------------------------------------------------------------
export const socialUrls = {
  instagram: "https://www.instagram.com/arkmediaorg/",
  x: "https://x.com/dansenor",
  tiktok: "https://www.tiktok.com/@arkmediaorg",
  facebook: "https://www.facebook.com/people/Ark-Media/61576391075039/",
  linkedin: "https://www.linkedin.com/company/ark-media1/",
  youtube: "https://www.youtube.com/@CallMeBackPodcast",
  spotify: "https://open.spotify.com/show/3btft3E1KPwj0yCOcOvqhR",
  applePodcasts: "https://podcasts.apple.com/us/podcast/call-me-back-with-dan-senor/id1539292794",
} as const;

// ---------------------------------------------------------------------------
// Contact addresses
// ---------------------------------------------------------------------------
export const contactEmails = {
  /** Every contact-form topic except support. On arkmedia.org because
      ark-plus.xyz has no MX record, so it receives no mail. */
  general: "hello@arkmedia.org",
  /** Membership and technical support — the desk the team staffs. Also where
      job applications go when a role has no apply link. */
  support: "support@arkmedia.org",
} as const;

/**
 * Topics offered by the /contact form. Each maps to the inbox the submission
 * is forwarded to: support to support@, everything else to hello@. Shared by
 * the form (dropdown) and the server route (topic → destination address), so
 * the two can never drift.
 */
export const contactTopics = [
  {
    value: "general",
    label: "Show ideas, feedback & corrections",
    email: contactEmails.general,
  },
  {
    value: "questions",
    label: "Listener questions",
    email: contactEmails.general,
  },
  {
    value: "press",
    label: "Press, interviews & media",
    email: contactEmails.general,
  },
  {
    value: "partnerships",
    label: "Sponsorships & partnerships",
    email: contactEmails.general,
  },
  {
    value: "institutions",
    label: "Group & institutional subscriptions",
    email: contactEmails.general,
  },
  {
    value: "support",
    label: "Membership and technical support",
    email: contactEmails.support,
  },
] as const;

export type ContactTopic = (typeof contactTopics)[number]["value"];

// ---------------------------------------------------------------------------
// The Fold (Circle) + companion apps
// ---------------------------------------------------------------------------
export const circleUrls = {
  /** Web home of the Fold (Circle). */
  community: "https://thefold.arkmedia.org",
  /** Universal app-open / SSO landing for the web app. */
  webApp: "https://thefold.arkmedia.org",
  /**
   * The events space, where every event lives in the app. Post URLs are opaque
   * hash-suffixed slugs that aren't derivable from our own ids, so this
   * deep-links to the space itself rather than a fabricated per-event
   *   permalink. The space slug is read from Circle's own `spaces` list, not
   * guessed (`events`, not a hash-suffixed slug).
   */
  eventsSpace: "https://thefold.arkmedia.org/c/events",
  /**
   * Where a member edits their own Fold profile — photo, headline, the
   * name other members see. Confirmed against the live Fold rather than
   * assumed: `/settings/profile` answers 302 (bounce to auth) while an unknown
   * path under `/settings` answers 404. Circle's API also hands back a
   * `profile_url` per member, but that is the PUBLIC `/u/<public_uid>` view
   * page — per-member, and not somewhere they can edit anything.
   */
  profileSettings: "https://thefold.arkmedia.org/settings/profile",
  /**
   * The Fold in the App Store. The `the-ark-media-community` segment is a
   * historical slug Apple built from the listing's old name; the `id…` segment
   * is what actually resolves, so this link stays correct through a rename and
   * is not a leftover to chase. Confirmed current 2026-09-08.
   */
  appStoreIos:
    "https://apps.apple.com/us/app/the-ark-media-community/id6775856136",
  /** The Fold on Google Play. */
  appStoreAndroid:
    "https://play.google.com/store/apps/details?id=org.arkmedia.app",
} as const;

/**
 * Circle space for each newsletter's mirrored discussion. The space slug
 * doesn't always match the newsletter slug, so this mapping is explicit.
 *
 * INTERIM: both point at The Conversation. The rebuilt Fold has no
 * per-newsletter spaces — the slugs these carried (`ark-daily`,
 * `inside-call-me-back`) no longer exist, so both links were 404s. Keep in step
 * with DISCUSS_SPACE_BINDINGS in server/lib/discuss-threads.ts, which is where
 * the threads are actually posted.
 */
export const newsletterCircleSpaces: Record<NewsletterSlug, string> = {
  "ark-daily": `${circleUrls.community}/c/conversation`,
};

// ---------------------------------------------------------------------------
// Podcast platform links (per show)
// ---------------------------------------------------------------------------
export const showListenLinks: Record<ShowSlug, ListenLink[]> = {
  "call-me-back": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/call-me-back-with-dan-senor/id1539292794" },
    { platform: "spotify", url: "https://open.spotify.com/show/3btft3E1KPwj0yCOcOvqhR" },
    { platform: "youtube", url: "https://www.youtube.com/@CallMeBackPodcast" },
  ],
  "call-me-back-plus": [],
  "for-heavens-sake": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/for-heavens-sake/id1522222281" },
    { platform: "spotify", url: "https://open.spotify.com/show/79j7N0DUYHOgrt3GUjiCzb" },
    { platform: "youtube", url: "https://www.youtube.com/@the.fhs.podcast" },
  ],
  "for-heavens-sake-plus": [],
  "ark-news-daily": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/ark-news-daily/id1885015768" },
    { platform: "spotify", url: "https://open.spotify.com/show/1O5ohSo8vLhudPTdSpXSwZ" },
  ],
  "ark-news-daily-plus": [],
  // PLACEHOLDER: these point at Ask a Jew, standing in until Chosen People
  // Problems has its own feeds. See the show entry in src/data/shows.ts.
  "chosen-people-problems": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/ask-a-jew/id1597767151" },
    { platform: "spotify", url: "https://open.spotify.com/show/1kJ4K907e9FuRcJQU4Pdjf" },
    { platform: "youtube", url: "https://www.youtube.com/@AskAJew" },
  ],
  "chosen-people-problems-plus": [],
};

/**
 * Spotify's own "Your Library → Podcasts" shelf. The fallback for a premium
 * show we don't have a Spotify show page for yet (see premiumSpotifyShows).
 */
export const spotifyLibraryUrl = "https://open.spotify.com/collection/podcasts";

/**
 * Spotify's Open Access page listing the member's linked accounts and the
 * shows each one unlocks (Beehiiv's recommendation, 2026-09-24). Also where a
 * member goes to unlink.
 */
export const spotifyContentAccessUrl = "https://content-access.spotify.com/";

/**
 * Beehiiv's Spotify Open Access partner ID. Public: it's in the
 * `<spotify:access><partner id="…"/>` tag of the feed Beehiiv serves Spotify
 * (confirmed 2026-09-24).
 */
const beehiivSpotifyPartnerId = "5l4n1gEAC81kHOQ6rFw3XU";

/**
 * Spotify's "you're linked" page for Beehiiv's partner ID, listing the shows the
 * link unlocked. Where a member lands after a successful link — see the
 * podcast-feed route. Spotify sends a signed-out visitor to its login first.
 */
export const spotifyLinkSuccessUrl = `https://content-access.spotify.com/oauth/success?partnerId=${beehiivSpotifyPartnerId}`;

/**
 * The Spotify show page for each premium show, keyed by Beehiiv show id
 * (`pod_<uuid>`, the same id as UserFeed.id). Where the feed setup page sends a
 * member to follow a show once Open Access has linked their account.
 *
 * One page per show, shared by every member — Open Access gates the episodes
 * by account, not by URL (a non-member who opens it just sees the lock).
 * Beehiiv's API doesn't expose these, so they live here. A show missing from
 * this map falls back to spotifyLibraryUrl.
 */
export const premiumSpotifyShows: Record<string, string> = {
  // Giraffe Sandbox NEW — Beehiiv's test premium show.
  "pod_01a05d4d-d91e-7d23-b20e-7c225707635e":
    "https://open.spotify.com/show/4ILTO8EcAStnyj5n40blWM",
  // For Heaven's Sake | Ark+
  "pod_01a087ad-c057-7777-8e69-cc88ed2eb995":
    "https://open.spotify.com/show/7Bu4rjmNegJ98HXiG26z2x",
  // Ark News Daily | Ark+
  "pod_01a087b1-cc11-7fd9-9a7a-06f22be61188":
    "https://open.spotify.com/show/2aCfy2SFFkDOUFC1Xbfwms",
  // Chosen People Problems | Ark+
  "pod_01a087b8-bfaa-782a-a835-e1a3a2bf5d86":
    "https://open.spotify.com/show/6hsCqZXUt81rwfLgBY3LrM",
};
