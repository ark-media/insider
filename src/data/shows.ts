import { showListenLinks } from "../config/urls";

export type ShowSlug =
  | "call-me-back"
  | "inside-call-me-back"
  | "for-heavens-sake"
  | "whats-your-number"
  | "ark-news-daily";

export type ShowRoute =
  | `/podcasts/${Exclude<ShowSlug, "inside-call-me-back">}`
  | "/plus/inside-call-me-back";

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
  /**
   * Square (1:1) cover art served from `/public`. When present it's used
   * everywhere the show is represented (hero, hub grid, related carousel);
   * shows without one fall back to generated artwork. Drop a file in
   * `public/shows/` and add its path here to give a show real branding.
   */
  coverArt?: string;
  /** Paid shows are gated behind Ark+ — no audio on the public site. */
  paid: boolean;
  /** Slugs of related shows (rendered in the carousel at the bottom of show pages). */
  related: ShowSlug[];
  listen: ListenLink[];
};

export const shows: Show[] = [
  {
    slug: "call-me-back",
    route: "/podcasts/call-me-back",
    title: "Call Me Back",
    shortTitle: "Call Me Back",
    tagline: "Conversations on the world Israel is shaping — and being shaped by.",
    description:
      "Dan Senor's flagship show un-breaks the news affecting the Jewish world, focusing on the structural forces shaping life in Israel and the diaspora.",
    hosts: ["Dan Senor"],
    cadence: "New episodes Sundays and Thursdays",
    coverArt: "/shows/call-me-back.jpg",
    paid: false,
    related: ["inside-call-me-back", "ark-news-daily", "for-heavens-sake"],
    listen: showListenLinks["call-me-back"],
  },
  {
    slug: "inside-call-me-back",
    route: "/plus/inside-call-me-back",
    title: "Inside Call Me Back",
    shortTitle: "Inside CMB",
    tagline: "The members-only companion to Call Me Back.",
    description:
      "Long-form interviews, unedited extras, and Q&As reserved for Ark+ members. Delivered as a private, ad-free feed in the podcast app you already use.",
    hosts: ["Dan Senor"],
    cadence: "New episodes weekly",
    coverArt: "/inside-cmb.jpg",
    paid: true,
    related: ["call-me-back", "for-heavens-sake", "whats-your-number"],
    listen: showListenLinks["inside-call-me-back"],
  },
  {
    slug: "for-heavens-sake",
    route: "/podcasts/for-heavens-sake",
    title: "For Heaven's Sake",
    shortTitle: "For Heaven's Sake",
    tagline: "A conversation about Israel, Jewish identity, and meaning.",
    description:
      "Donniel Hartman and Yossi Klein Halevi engage in the Jewish tradition of intense dialectic on all topics related to Israel, the Jewish diaspora, and the future of Zionism.",
    hosts: ["Donniel Hartman", "Yossi Klein Halevi"],
    cadence: "Weekly",
    coverArt: "/shows/for-heavens-sake.jpg",
    paid: false,
    related: ["call-me-back", "whats-your-number", "ark-news-daily"],
    listen: showListenLinks["for-heavens-sake"],
  },
  {
    slug: "whats-your-number",
    route: "/podcasts/whats-your-number",
    title: "What's Your Number?",
    shortTitle: "What's Your Number?",
    tagline: "Looking at the Israeli economy through a global lens.",
    description:
      "Hosted by Yonatan Adiri and Michal Lev-Ram, What's Your Number? delves into the forces shaping the Israeli economy from within and without.",
    hosts: ["Yonatan Adiri", "Michal Lev-Ram"],
    cadence: "Weekly",
    coverArt: "/shows/whats-your-number.jpg",
    paid: false,
    related: ["ark-news-daily", "call-me-back", "for-heavens-sake"],
    listen: showListenLinks["whats-your-number"],
  },
  {
    slug: "ark-news-daily",
    route: "/podcasts/ark-news-daily",
    title: "Ark News Daily",
    shortTitle: "Ark News Daily",
    tagline: "A fast, focused brief on the day's most consequential story.",
    description:
      "Ten minutes, every weekday. The single news item that matters most — explained without the noise.",
    hosts: ["Ark Media newsroom"],
    cadence: "Weekdays, 7:00 AM ET",
    coverArt: "/shows/ark-news-daily.jpg",
    paid: false,
    related: ["call-me-back", "whats-your-number", "for-heavens-sake"],
    listen: showListenLinks["ark-news-daily"],
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
 * The atmospheric backdrop utility class for a show's hero and episode
 * headers — a bespoke brand "wash" that gives each show its own sense of place
 * instead of a flat panel. Each class shares one composition (see src/index.css)
 * so the set reads as a family. Any unmapped show falls back to the house Ark
 * wave; a new bespoke wash is one case here plus a class in src/index.css.
 */
export function showAtmosphere(slug: ShowSlug): string {
  switch (slug) {
    case "call-me-back":
      return "cmb-bg";
    case "inside-call-me-back":
      return "icmb-bg";
    case "for-heavens-sake":
      return "fhs-bg";
    case "whats-your-number":
      return "wyn-bg";
    case "ark-news-daily":
      return "and-bg";
    default:
      return "ark-bg";
  }
}

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
