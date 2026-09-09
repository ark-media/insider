import { showListenLinks } from "../config/urls.js";

export type ShowSlug =
  | "call-me-back"
  | "inside-call-me-back"
  | "for-heavens-sake"
  | "ark-news-daily"
  | "chosen-people-problems";

type ShowRoute =
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
   * everywhere the show is represented (hero, hub grid); shows without one
   * fall back to generated artwork. Drop a file in `public/shows/` and add
   * its path here to give a show real branding.
   */
  coverArt?: string;
  /** Paid shows are gated behind Ark+ — no audio on the public site. */
  paid: boolean;
  listen: ListenLink[];
};

export const shows: Show[] = [
  {
    slug: "call-me-back",
    route: "/podcasts/call-me-back",
    title: "Call Me Back",
    shortTitle: "Call Me Back",
    tagline:
      "Call Me Back un-breaks the news affecting the Jewish world, focusing on the structural forces shaping life in Israel and the diaspora.",
    description:
      "Call Me Back un-breaks the news affecting the Jewish world, focusing on the structural forces shaping life in Israel and the diaspora.",
    hosts: ["Dan Senor"],
    cadence: "New episodes Mondays and Thursdays",
    coverArt: "/shows/call-me-back.jpg",
    paid: false,
    listen: showListenLinks["call-me-back"],
  },
  // {
  //   slug: "inside-call-me-back",
  //   route: "/plus/inside-call-me-back",
  //   title: "Call Me Back AMA",
  //   shortTitle: "CMB AMA",
  //   tagline:
  //     "Presenting the challenges and dilemmas facing Israelis to a global audience.",
  //   description:
  //     "Long-form interviews, unedited extras, and Q&As reserved for Ark+ members. Delivered as a private, ad-free feed in the podcast app you already use.",
  //   hosts: ["Dan Senor"],
  //   cadence: "New episodes weekly",
  //   coverArt: "/inside-cmb.jpg",
  //   paid: true,
  //   listen: showListenLinks["inside-call-me-back"],
  // },
  {
    slug: "for-heavens-sake",
    route: "/podcasts/for-heavens-sake",
    title: "For Heaven's Sake",
    shortTitle: "For Heaven's Sake",
    tagline:
      "Donniel Hartman and Yossi Klein Halevi engage in the Jewish tradition of constructive disagreement about Israel, world Jewry, and the future of Zionism.",
    description:
      "Donniel Hartman and Yossi Klein Halevi engage in the Jewish tradition of constructive disagreement about Israel, world Jewry, and the future of Zionism.",
    hosts: ["Donniel Hartman", "Yossi Klein Halevi"],
    cadence: "Weekly",
    coverArt: "/shows/for-heavens-sake.jpg",
    paid: false,
    listen: showListenLinks["for-heavens-sake"],
  },
  {
    slug: "ark-news-daily",
    route: "/podcasts/ark-news-daily",
    title: "Ark News Daily",
    shortTitle: "Ark News Daily",
    tagline:
      "Every morning, Ark Media gives you the latest updates on the war in Iran and how they impact the Middle East, geopolitics, and Jews around the world.",
    description:
      "Every morning, Ark Media gives you the latest updates on the war in Iran and how they impact the Middle East, geopolitics, and Jews around the world.",
    hosts: ["Ark Media newsroom"],
    cadence: "Weekdays",
    coverArt: "/shows/ark-news-daily.jpg",
    paid: false,
    listen: showListenLinks["ark-news-daily"],
  },
  // PLACEHOLDER CONTENT. Chosen People Problems has no assets of its own yet, so
  // it stands up on Ask a Jew's cover art, description, hosts, and listen links
  // (Ava's call — "use Ask a Jew materials for now"). Every field below except
  // `slug`, `route`, `title`, and `shortTitle` is Ask a Jew's and needs
  // replacing. It is also absent from `schedule` below: we don't know when it
  // drops, and a guess would put a wrong show in the masthead's next-drop strip.
  {
    slug: "chosen-people-problems",
    route: "/podcasts/chosen-people-problems",
    title: "Chosen People Problems",
    shortTitle: "Chosen People Problems",
    tagline:
      "Yael Bar tur, secular sinner, and Chaya Leah Sufrin, pious Haredi, ask each other the hard questions, from Torah to Tinder.",
    description:
      "Yael Bar tur, secular sinner, and Chaya Leah Sufrin, pious Haredi, ask each other the hard questions, from Torah to Tinder.",
    hosts: ["Yael Bar tur", "Chaya Leah Sufrin"],
    cadence: "Weekly",
    coverArt: "/shows/chosen-people-problems.jpg",
    paid: false,
    listen: showListenLinks["chosen-people-problems"],
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
    case "ark-news-daily":
      return "and-bg";
    default:
      return "ark-bg";
  }
}

