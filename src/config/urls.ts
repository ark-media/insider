import type { NewsletterSlug } from "../data/newsletters";
import type { ListenLink, ShowSlug } from "../data/shows";

/**
 * Single source of truth for every brand-owned and external URL the site
 * links out to. If a URL points at an Ark Media property or a third-party
 * profile/app, it belongs here — not inline in a component or data file.
 *
 * Intentionally NOT here (they're infra/SDK bases, env-driven or framework
 * config, and change per environment rather than per brand):
 *   - PostHog host            → VITE_POSTHOG_HOST (src/lib/observability.ts)
 *   - Simplecast player base  → src/lib/simplecast.ts
 *   - YouTube embed base      → src/routes/israel-votes.tsx
 *   - Google Fonts            → index.html
 * Per-episode media URLs (audio, thumbnails) also stay with their data,
 * since episode data is fetched from Simplecast at runtime.
 *
 * TODO(ark): values marked PLACEHOLDER need a real Ark Media URL before launch.
 */

/** The apex domain, for building addresses without retyping it. */
export const ARK_DOMAIN = "ark-plus.xyz";

// ---------------------------------------------------------------------------
// Social profiles
// ---------------------------------------------------------------------------
export const socialUrls = {
  instagram: "https://www.instagram.com/arkmediaorg/",
  x: "https://x.com/dansenor",
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
  /** Ark+ membership support. */
  support: `support@${ARK_DOMAIN}`,
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
    label: "Ark+ membership support",
    email: contactEmails.support,
  },
] as const;

export type ContactTopic = (typeof contactTopics)[number]["value"];

// ---------------------------------------------------------------------------
// Circle community + companion apps
// ---------------------------------------------------------------------------
export const circleUrls = {
  /** Web home of the Ark+ community (Circle). */
  community: "https://app.arkmedia.org",
  /** Universal app-open / SSO landing for the web app. */
  webApp: "https://app.arkmedia.org",
  /** Circle Communities app in the App Store. */
  appStoreIos: "https://apps.apple.com/app/circle-communities/id1525026498",
  /** Community app on Google Play. */
  appStoreAndroid:
    "https://play.google.com/store/apps/details?id=com.circle.circleapp",
} as const;

/**
 * Circle space for each newsletter's mirrored discussion. The space slug
 * doesn't always match the newsletter slug, so this mapping is explicit.
 */
export const newsletterCircleSpaces: Record<NewsletterSlug, string> = {
  "ark-daily": `${circleUrls.community}/c/ark-daily`,
  "members-letter": `${circleUrls.community}/c/inside-call-me-back`,
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
};
