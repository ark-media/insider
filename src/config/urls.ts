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

/** The apex domain, for building addresses without retyping it. */
const ARK_DOMAIN = "ark-plus.xyz";

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
  /** Listener mail — show ideas, feedback, corrections. */
  general: `hello@${ARK_DOMAIN}`,
  /** Press, interviews, media inquiries. */
  press: `press@${ARK_DOMAIN}`,
  /** Sponsorships and partnerships. */
  partnerships: `partners@${ARK_DOMAIN}`,
  /** Membership and technical support. Deliberately on arkmedia.org, not
      ARK_DOMAIN — this is the desk the team actually staffs. */
  support: "support@arkmedia.org",
  /** Inside Call Me Back subscription/billing support, handled by SupportingCast
      (the podcast subscription platform) — not a brand-domain inbox. */
  podcastSupport: "help@supportingcast.fm",
  /** Job applications. */
  careers: `careers@${ARK_DOMAIN}`,
} as const;

/**
 * Topics offered by the /contact form. Each maps to the inbox the submission
 * is forwarded to. Shared by the form (dropdown) and the server route
 * (topic → destination address), so the two can never drift.
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
    email: contactEmails.press,
  },
  {
    value: "partnerships",
    label: "Sponsorships & partnerships",
    email: contactEmails.partnerships,
  },
  {
    value: "support",
    label: "Membership and technical support",
    email: contactEmails.support,
  },
] as const;

export type ContactTopic = (typeof contactTopics)[number]["value"];

// ---------------------------------------------------------------------------
// Circle community + companion apps
// ---------------------------------------------------------------------------
export const circleUrls = {
  /** Web home of the Ark+ community (Circle). */
  community: "https://thefold.arkmedia.org",
  /** Universal app-open / SSO landing for the web app. */
  webApp: "https://thefold.arkmedia.org",
  /**
   * The events space, where every event lives in the app. Post URLs are opaque
   * hash-suffixed slugs that aren't derivable from our own ids, so this
   * deep-links to the space itself rather than a fabricated per-event
   * permalink. The space slug is read from Circle's own `spaces` list, not
   * guessed — the rebuilt community dropped the hash suffixes the old slugs
   * carried (`events-71d23b` → `events`).
   */
  eventsSpace: "https://thefold.arkmedia.org/c/events",
  /**
   * Where a member edits their own community profile — photo, headline, the
   * name other members see. Confirmed against the live community rather than
   * assumed: `/settings/profile` answers 302 (bounce to auth) while an unknown
   * path under `/settings` answers 404. Circle's API also hands back a
   * `profile_url` per member, but that is the PUBLIC `/u/<public_uid>` view
   * page — per-member, and not somewhere they can edit anything.
   */
  profileSettings: "https://thefold.arkmedia.org/settings/profile",
  /** The Ark Media Community app in the App Store. */
  appStoreIos:
    "https://apps.apple.com/us/app/the-ark-media-community/id6775856136",
  /** The Ark Media Community app on Google Play. */
  appStoreAndroid:
    "https://play.google.com/store/apps/details?id=org.arkmedia.app",
} as const;

/**
 * Circle space for each newsletter's mirrored discussion. The space slug
 * doesn't always match the newsletter slug, so this mapping is explicit.
 *
 * INTERIM: both point at The Conversation. The rebuilt community has no
 * per-newsletter spaces — the slugs these carried (`ark-daily`,
 * `inside-call-me-back`) no longer exist, so both links were 404s. Keep in step
 * with DISCUSS_SPACE_BINDINGS in server/lib/discuss-threads.ts, which is where
 * the threads are actually posted.
 */
export const newsletterCircleSpaces: Record<NewsletterSlug, string> = {
  "ark-daily": `${circleUrls.community}/c/conversation`,
  "members-letter": `${circleUrls.community}/c/conversation`,
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
  "inside-call-me-back": [],
  "for-heavens-sake": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/for-heavens-sake/id1522222281" },
    { platform: "spotify", url: "https://open.spotify.com/show/79j7N0DUYHOgrt3GUjiCzb" },
    { platform: "youtube", url: "https://www.youtube.com/@the.fhs.podcast" },
  ],
  "whats-your-number": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/whats-your-number/id1810695711" },
    { platform: "spotify", url: "https://open.spotify.com/show/575KzqLWPUyFLjmMPzqWXn" },
    { platform: "youtube", url: "https://www.youtube.com/@wyn.podcast" },
  ],
  "ark-news-daily": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/ark-news-daily/id1885015768" },
    { platform: "spotify", url: "https://open.spotify.com/show/1O5ohSo8vLhudPTdSpXSwZ" },
  ],
  // PLACEHOLDER: these point at Ask a Jew, standing in until Chosen People
  // Problems has its own feeds. See the show entry in src/data/shows.ts.
  "chosen-people-problems": [
    { platform: "apple", url: "https://podcasts.apple.com/us/podcast/ask-a-jew/id1597767151" },
    { platform: "spotify", url: "https://open.spotify.com/show/1kJ4K907e9FuRcJQU4Pdjf" },
    { platform: "youtube", url: "https://www.youtube.com/@AskAJew" },
  ],
};
