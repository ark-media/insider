import type { ShowSlug } from "./shows";

export type HostSlug =
  | "dan-senor"
  | "donniel-hartman"
  | "yossi-klein-halevi"
  | "nadav-eyal"
  | "amit-segal"
  | "yonatan-adiri"
  | "yael-wissner-levy";

export type Host = {
  slug: HostSlug;
  name: string;
  role: string;
  shortBio: string;
  longBio: string;
  shows: ShowSlug[];
  initials: string;
  /**
   * Square-ish portrait served from `/public/hosts`. When present it replaces
   * the generated initials artwork everywhere the host is shown.
   */
  headshot?: string;
};

export const hosts: Host[] = [
  {
    slug: "dan-senor",
    name: "Dan Senor",
    role: "Host, Call Me Back",
    shortBio:
      "Author of The Genius of Israel and Start-Up Nation. Former foreign policy advisor.",
    longBio:
      "Dan Senor is the host of Call Me Back and Inside Call Me Back. He is the co-author of The Genius of Israel (2023) and Start-Up Nation (2009), and previously served as a senior foreign policy advisor in two White Houses. He writes and speaks regularly on the structural forces shaping Israel and the diaspora.",
    shows: ["call-me-back", "inside-call-me-back"],
    initials: "DS",
    headshot: "/hosts/dan-senor.jpg",
  },
  {
    slug: "donniel-hartman",
    name: "Donniel Hartman",
    role: "Host, For Heaven's Sake",
    shortBio:
      "President of the Shalom Hartman Institute. Modern Orthodox rabbi, philosopher, author.",
    longBio:
      "Rabbi Donniel Hartman is the President of the Shalom Hartman Institute and the founder of its iEngage Project. His books include Putting God Second and Who Are the Jews — and Who Can We Become. He co-hosts For Heaven's Sake with Yossi Klein Halevi.",
    shows: ["for-heavens-sake"],
    initials: "DH",
    headshot: "/hosts/donniel-hartman.jpg",
  },
  {
    slug: "yossi-klein-halevi",
    name: "Yossi Klein Halevi",
    role: "Host, For Heaven's Sake",
    shortBio:
      "Senior Fellow at the Shalom Hartman Institute. Author of Letters to My Palestinian Neighbor.",
    longBio:
      "Yossi Klein Halevi is the author of Letters to My Palestinian Neighbor and Like Dreamers. A Senior Fellow at the Shalom Hartman Institute in Jerusalem, he co-hosts For Heaven's Sake with Donniel Hartman.",
    shows: ["for-heavens-sake"],
    initials: "YK",
    headshot: "/hosts/yossi-klein-halevi.jpg",
  },
  {
    slug: "nadav-eyal",
    name: "Nadav Eyal",
    role: "Recurring guest, Call Me Back",
    shortBio:
      "Columnist at Yedioth Ahronoth. Author of Revolt. One of Israel's most read journalists.",
    longBio:
      "Nadav Eyal is one of Israel's leading journalists and a columnist at Yedioth Ahronoth. His book Revolt (Ecco, 2021) won the Bernstein Prize. He appears regularly on Call Me Back for analysis on Israeli politics and security.",
    shows: ["call-me-back", "inside-call-me-back"],
    initials: "NE",
    headshot: "/hosts/nadav-eyal.jpg",
  },
  {
    slug: "amit-segal",
    name: "Amit Segal",
    role: "Recurring guest, Call Me Back",
    shortBio:
      "Chief political analyst for Channel 12 News. The most quoted political voice in Israel.",
    longBio:
      "Amit Segal is the chief political analyst for Channel 12 News in Israel and a columnist at Yedioth Ahronoth. He is widely regarded as one of the most influential political journalists in Israel.",
    shows: ["call-me-back", "inside-call-me-back"],
    initials: "AS",
    headshot: "/hosts/amit-segal.jpg",
  },
  {
    slug: "yonatan-adiri",
    name: "Yonatan Adiri",
    role: "Host, What's Your Number",
    shortBio:
      "Yonatan Adiri is an Israeli entrepreneur and co-host of Ark Media’s What’s Your Number? podcast. ",
    longBio: "Yonatan Adiri is an Israeli entrepreneur. From 2008-2011, Yonatan served as Chief Technology Officer for former Israeli President Shimon Peres. In 2013, Yonatan established Healthy.io, a digital healthcare start-up that helps doctors diagnose patients using images from smartphones. In 2020, he was selected to Fortune Magazine’s 40 under 40 list.",
    shows: ["whats-your-number"],
    initials: "YA",
    headshot: "/hosts/yonatan-adiri.jpg",
  },
  {
    slug: "yael-wissner-levy",
    name: "Yael Wissner-Levy",
    role: "Host, What's Your Number",
    shortBio: "Yael Wissner-Levy is co-host of Ark Media’s What’s Your Number? podcast and the Chief Communications Officer at Tenzai, an early-stage AI-native cybersecurity company",
    longBio: "Yael Wissner-Levy is the Chief Communications Officer at Tenzai, an early-stage AI-native cybersecurity company building AI hackers to ensure enterprises deliver unbreakable code. Previously, she served as VP Communications at Lemonade, a NYSE-traded insurance company powered by AI, from seed stage to public markets. Prior to that, she served as a speechwriter and communications consultant for Israeli political and business leaders, and in media, as both a television news presenter and journalist at various outlets including i24 News (i24news.com), Israel’s Channel 10 (now Channel 13), and an editor at Ha’aretz (haaretz.com). She started her career working for former US Representative Steve Israel in the US Congress. Yael holds a MSc in International Relations from the London School of Economics.",
    shows: ["whats-your-number"],
    initials: "YW",
    headshot: "/hosts/yael-wissner-levy.jpg",
  }
];

export function getHost(slug: string): Host | undefined {
  return hosts.find((h) => h.slug === slug);
}

export function hostsForShow(showSlug: ShowSlug): Host[] {
  return hosts.filter((h) => h.shows.includes(showSlug));
}
