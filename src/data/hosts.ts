import type { ShowSlug } from "./shows";

export type HostSlug =
  | "dan-senor"
  | "donniel-hartman"
  | "yossi-klein-halevi"
  | "nadav-eyal"
  | "amit-segal"
  | "yonatan-adiri"
  | "yael-wissner-levy"
  | "deborah-pardes";

export type HostKind = "host" | "contributor";

export type Host = {
  slug: HostSlug;
  name: string;
  kind: HostKind;
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
    kind: "host",
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
    kind: "host",
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
    kind: "host",
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
    kind: "contributor",
    role: "Call Me Back Contributor",
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
    kind: "contributor",
    role: "Call Me Back Contributor",
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
    kind: "host",
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
    kind: "host",
    role: "Host, What's Your Number",
    shortBio: "Yael Wissner-Levy is co-host of Ark Media’s What’s Your Number? podcast and the Chief Communications Officer at Tenzai, an early-stage AI-native cybersecurity company",
    longBio: "Yael Wissner-Levy is the Chief Communications Officer at Tenzai, an early-stage AI-native cybersecurity company building AI hackers to ensure enterprises deliver unbreakable code. Previously, she served as VP Communications at Lemonade, a NYSE-traded insurance company powered by AI, from seed stage to public markets. Prior to that, she served as a speechwriter and communications consultant for Israeli political and business leaders, and in media, as both a television news presenter and journalist at various outlets including i24 News (i24news.com), Israel’s Channel 10 (now Channel 13), and an editor at Ha’aretz (haaretz.com). She started her career working for former US Representative Steve Israel in the US Congress. Yael holds a MSc in International Relations from the London School of Economics.",
    shows: ["whats-your-number"],
    initials: "YW",
    headshot: "/hosts/yael-wissner-levy.jpg",
  },
  {
    slug: "deborah-pardes",
    name: "Deborah Pardes",
    kind: "host",
    role: "Host, Ark News Daily",
    shortBio:
      "Founder of The Play Full Society. Former VP of Stories & Voices at Swell; founded Artists for Literacy, recognized by The New York Times, NPR, and Rolling Stone.",
    longBio:
      "Deborah Pardes is a visionary executive, storyteller, and founder of The Play Full Society, a new membership-based club reimagining how adults connect—through play, creativity, and authentic human interaction. With decades of leadership in content, community, and culture, she has shaped transformative experiences across media, education, and technology. Previously, as VP of Stories & Voices at Swell, Deborah championed accessibility in podcasting and helped thousands of creators find their voice. Her earlier work includes founding Artists for Literacy, a national arts and education movement recognized by The New York Times, Rolling Stone, and NPR. A Barnard College alum and lifelong creator, Deborah continues to build spaces and stories that inspire joy, empathy, and connection.",
    shows: ["ark-news-daily"],
    initials: "DP",
    headshot: "/hosts/deborah-pardes.jpg",
  },
];

export function getHost(slug: string): Host | undefined {
  return hosts.find((h) => h.slug === slug);
}

function peopleForShow(showSlug: ShowSlug, kind: HostKind): Host[] {
  return hosts.filter((h) => h.shows.includes(showSlug) && h.kind === kind);
}

export function hostsForShow(showSlug: ShowSlug): Host[] {
  return peopleForShow(showSlug, "host");
}

export function contributorsForShow(showSlug: ShowSlug): Host[] {
  return peopleForShow(showSlug, "contributor");
}
