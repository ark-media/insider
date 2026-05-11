export type ShowSlug =
  | "call-me-back"
  | "inside-call-me-back"
  | "for-heavens-sake"
  | "whats-your-number"
  | "ark-news-daily";

export type ShowRoute = `/shows/${ShowSlug}`;

export type ListenPlatform =
  | "apple"
  | "spotify"
  | "overcast"
  | "pocket-casts"
  | "youtube";

export type ListenLink = { platform: ListenPlatform; url: string };

export type Show = {
  slug: ShowSlug;
  route: ShowRoute;
  title: string;
  shortTitle: string;
  tagline: string;
  description: string;
  hosts: string[];
  cadence: string;
  /** Paid shows are gated behind Ark+ — no audio on the public site. */
  paid: boolean;
  /** Slugs of related shows (rendered in the carousel at the bottom of show pages). */
  related: ShowSlug[];
  listen: ListenLink[];
  /**
   * Simplecast podcast UUID for the show-level playlist embed.
   * Find it in the Simplecast dashboard under Distribution → Embeds → All Episodes.
   * When set, the public show page renders the Simplecast playlist player.
   */
  simplecastPodcastId?: string;
};

export const shows: Show[] = [
  {
    slug: "call-me-back",
    route: "/shows/call-me-back",
    title: "Call Me Back",
    shortTitle: "Call Me Back",
    tagline: "Conversations on the world Israel is shaping — and being shaped by.",
    description:
      "Dan Senor's flagship show un-breaks the news affecting the Jewish world, focusing on the structural forces shaping life in Israel and the diaspora.",
    hosts: ["Dan Senor"],
    cadence: "New episodes Sundays and Thursdays",
    paid: false,
    related: ["inside-call-me-back", "ark-news-daily", "for-heavens-sake"],
    listen: [
      { platform: "apple", url: "https://podcasts.apple.com/us/podcast/call-me-back-with-dan-senor/id1471232474" },
      { platform: "spotify", url: "https://open.spotify.com/show/0VXHB5Wjd1RNwCWtRkM1HC" },
      { platform: "overcast", url: "https://overcast.fm/itunes1471232474" },
      { platform: "pocket-casts", url: "https://pca.st/podcast/9d6a14e0-bbcb-0137-8eea-0acc26574db2" },
      { platform: "youtube", url: "https://www.youtube.com/@CallMeBackPodcast" },
    ],
    simplecastPodcastId: "REPLACE_WITH_CALL_ME_BACK_PODCAST_UUID",
  },
  {
    slug: "inside-call-me-back",
    route: "/shows/inside-call-me-back",
    title: "Inside Call Me Back",
    shortTitle: "Inside CMB",
    tagline: "The members-only companion to Call Me Back.",
    description:
      "Long-form interviews, unedited extras, and Q&As reserved for Ark+ members. Delivered as a private, ad-free feed in the podcast app you already use.",
    hosts: ["Dan Senor"],
    cadence: "New episodes weekly",
    paid: true,
    related: ["call-me-back", "for-heavens-sake", "whats-your-number"],
    listen: [],
  },
  {
    slug: "for-heavens-sake",
    route: "/shows/for-heavens-sake",
    title: "For Heaven's Sake",
    shortTitle: "For Heaven's Sake",
    tagline: "A conversation about Israel, Jewish identity, and meaning.",
    description:
      "Donniel Hartman and Yossi Klein Halevi in dialogue on the questions that don't go away.",
    hosts: ["Donniel Hartman", "Yossi Klein Halevi"],
    cadence: "Weekly",
    paid: false,
    related: ["call-me-back", "whats-your-number", "ark-news-daily"],
    listen: [
      { platform: "apple", url: "https://podcasts.apple.com/us/podcast/for-heavens-sake/id1497635252" },
      { platform: "spotify", url: "https://open.spotify.com/show/4eFsQEm56jeazfH5qzdxMq" },
      { platform: "overcast", url: "https://overcast.fm/itunes1497635252" },
    ],
    simplecastPodcastId: "REPLACE_WITH_FOR_HEAVENS_SAKE_PODCAST_UUID",
  },
  {
    slug: "whats-your-number",
    route: "/shows/whats-your-number",
    title: "What's Your Number",
    shortTitle: "What's Your Number",
    tagline: "Numbers that explain the moment.",
    description:
      "A single statistic, unpacked. What does it really tell us — and what doesn't it?",
    hosts: ["Ark Media newsroom"],
    cadence: "Weekly",
    paid: false,
    related: ["ark-news-daily", "call-me-back", "for-heavens-sake"],
    listen: [
      { platform: "apple", url: "https://podcasts.apple.com/" },
      { platform: "spotify", url: "https://open.spotify.com/" },
    ],
    simplecastPodcastId: "REPLACE_WITH_WHATS_YOUR_NUMBER_PODCAST_UUID",
  },
  {
    slug: "ark-news-daily",
    route: "/shows/ark-news-daily",
    title: "Ark News Daily",
    shortTitle: "Ark News Daily",
    tagline: "A fast, focused brief on the day's most consequential story.",
    description:
      "Ten minutes, every weekday. The single news item that matters most — explained without the noise.",
    hosts: ["Ark Media newsroom"],
    cadence: "Weekdays, 7:00 AM ET",
    paid: false,
    related: ["call-me-back", "whats-your-number", "for-heavens-sake"],
    listen: [
      { platform: "apple", url: "https://podcasts.apple.com/" },
      { platform: "spotify", url: "https://open.spotify.com/" },
    ],
    simplecastPodcastId: "REPLACE_WITH_ARK_NEWS_DAILY_PODCAST_UUID",
  },
];

export function getShow(slug: string): Show | undefined {
  return shows.find((s) => s.slug === slug);
}

export const LISTEN_PLATFORM_LABEL: Record<ListenPlatform, string> = {
  apple: "Apple Podcasts",
  spotify: "Spotify",
  overcast: "Overcast",
  "pocket-casts": "Pocket Casts",
  youtube: "YouTube",
};

/**
 * Editorial schedule — used by the masthead live-status strip.
 * Days are 0 = Sun … 6 = Sat (in America/New_York). Hour is ET.
 */
type DropSchedule = { showSlug: ShowSlug; days: number[]; hour: number };

const schedule: DropSchedule[] = [
  { showSlug: "call-me-back", days: [0, 4], hour: 6 },
  { showSlug: "inside-call-me-back", days: [2], hour: 6 },
  { showSlug: "ark-news-daily", days: [1, 2, 3, 4, 5], hour: 7 },
  { showSlug: "for-heavens-sake", days: [3], hour: 6 },
  { showSlug: "whats-your-number", days: [1], hour: 6 },
];

export type NextDrop = {
  show: Show;
  when: Date;
  /** Pretty label like "Tomorrow" or "Thursday" or "In 2 hours" */
  relative: string;
};

function partsInZone(d: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: dayMap[parts.weekday as string] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/**
 * Returns the next scheduled drop across all shows, given a "now" timestamp.
 * Optimized for clarity over precision — minutes are not exact across DST,
 * but the relative label is honest within ±1h.
 */
export function nextDrop(now: Date = new Date()): NextDrop | null {
  const zone = "America/New_York";
  const nowParts = partsInZone(now, zone);

  let best: { showSlug: ShowSlug; daysAhead: number; hour: number } | null = null;
  for (const s of schedule) {
    for (const d of s.days) {
      let daysAhead = (d - nowParts.weekday + 7) % 7;
      if (daysAhead === 0 && nowParts.hour >= s.hour) daysAhead = 7;
      if (!best || daysAhead < best.daysAhead || (daysAhead === best.daysAhead && s.hour < best.hour)) {
        best = { showSlug: s.showSlug, daysAhead, hour: s.hour };
      }
    }
  }
  if (!best) return null;

  const show = getShow(best.showSlug);
  if (!show) return null;

  const when = new Date(now);
  when.setDate(when.getDate() + best.daysAhead);
  when.setHours(best.hour, 0, 0, 0);

  let relative: string;
  if (best.daysAhead === 0) {
    const hoursOut = best.hour - nowParts.hour;
    relative = hoursOut <= 1 ? "Today" : `Today · ${best.hour}am ET`;
  } else if (best.daysAhead === 1) {
    relative = "Tomorrow";
  } else {
    const weekdayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      (nowParts.weekday + best.daysAhead) % 7
    ];
    relative = weekdayName;
  }

  return { show, when, relative };
}
