import type { ShowSlug } from "./shows";

export type Episode = {
  showSlug: ShowSlug;
  slug: string;
  title: string;
  /** ISO date — when the episode dropped */
  publishedAt: string;
  durationMinutes: number;
  description: string;
  /** Optional list of guest names. */
  guests?: string[];
  /**
   * Simplecast episode UUID. Present on episodes fetched from the
   * Simplecast API; absent on local mock data (e.g. the paid show).
   * When present, the episode page renders the real Simplecast player.
   */
  id?: string;
};

/**
 * Mock episode catalog. Newest first within each show.
 * The shape mirrors what a real Simplecast episode response would give us
 * after light projection — keeping the UI free to swap to live data later.
 */
export const episodes: Episode[] = [
  // Call Me Back
  {
    showSlug: "call-me-back",
    slug: "the-day-after",
    title: "The day after — Israel and the architecture of what comes next",
    publishedAt: "2026-04-27",
    durationMinutes: 64,
    description:
      "What does a credible 'day after' framework actually look like? We talk through the security architecture, the regional map, and the politics of the moment.",
    guests: ["Nadav Eyal"],
  },
  {
    showSlug: "call-me-back",
    slug: "coalition-math",
    title: "Coalition math, six months out",
    publishedAt: "2026-04-23",
    durationMinutes: 58,
    description:
      "A close read of the polls and the coalition arithmetic. What scenarios are realistic, and which ones do the numbers rule out?",
    guests: ["Amit Segal"],
  },
  {
    showSlug: "call-me-back",
    slug: "the-cairo-channel",
    title: "The Cairo channel",
    publishedAt: "2026-04-20",
    durationMinutes: 71,
    description:
      "Why the most consequential negotiations are the ones nobody wants to put on a flag.",
    guests: ["Dennis Ross"],
  },
  {
    showSlug: "call-me-back",
    slug: "diaspora-fault-lines",
    title: "Diaspora fault lines",
    publishedAt: "2026-04-16",
    durationMinutes: 55,
    description:
      "American Jewish institutional life is moving, fast. A reporter's notebook from a year on the road.",
  },
  {
    showSlug: "call-me-back",
    slug: "the-startup-nation-question",
    title: "The Start-Up Nation question, fifteen years on",
    publishedAt: "2026-04-13",
    durationMinutes: 62,
    description:
      "A return to first principles: what was the argument, what's held up, and what hasn't.",
  },

  // Inside Call Me Back (paid)
  {
    showSlug: "inside-call-me-back",
    slug: "extended-eyal",
    title: "The full Nadav Eyal — the parts we couldn't fit",
    publishedAt: "2026-04-29",
    durationMinutes: 92,
    description:
      "The unedited interview. Forty additional minutes of Nadav, including the section on regional security architecture that didn't make the public cut.",
    guests: ["Nadav Eyal"],
  },
  {
    showSlug: "inside-call-me-back",
    slug: "members-qa-april",
    title: "Members Q&A — April",
    publishedAt: "2026-04-25",
    durationMinutes: 49,
    description:
      "Dan answers questions submitted by Ark+ members, on coalition math, the campus picture, and what Nadav is reading.",
  },
  {
    showSlug: "inside-call-me-back",
    slug: "off-record-cairo",
    title: "Off-record: the Cairo backstory",
    publishedAt: "2026-04-21",
    durationMinutes: 38,
    description:
      "What we couldn't say on the public episode. Reserved for Ark+ members.",
  },
  {
    showSlug: "inside-call-me-back",
    slug: "ad-free-archive-march",
    title: "March archive, ad-free",
    publishedAt: "2026-04-01",
    durationMinutes: 0,
    description:
      "The full month of public episodes, re-cut without ads, in the Ark+ private feed.",
  },

  // For Heaven's Sake
  {
    showSlug: "for-heavens-sake",
    slug: "what-we-owe-each-other",
    title: "What we owe each other",
    publishedAt: "2026-04-24",
    durationMinutes: 47,
    description:
      "Donniel and Yossi on the moral arithmetic of solidarity inside a fractured Jewish people.",
  },
  {
    showSlug: "for-heavens-sake",
    slug: "the-prayer-problem",
    title: "The prayer problem",
    publishedAt: "2026-04-17",
    durationMinutes: 51,
    description:
      "A conversation about what Jewish prayer is for, and what it can no longer ignore.",
  },
  {
    showSlug: "for-heavens-sake",
    slug: "after-the-rallies",
    title: "After the rallies",
    publishedAt: "2026-04-10",
    durationMinutes: 49,
    description:
      "What does it mean to be a public Jew in the absence of a unifying public moment?",
  },

  // What's Your Number
  {
    showSlug: "whats-your-number",
    slug: "fourteen-percent",
    title: "14%",
    publishedAt: "2026-04-22",
    durationMinutes: 12,
    description:
      "The single statistic that explains why the next election is going to feel different.",
  },
  {
    showSlug: "whats-your-number",
    slug: "two-million",
    title: "2,000,000",
    publishedAt: "2026-04-15",
    durationMinutes: 11,
    description:
      "What two million displaced people in a single region tell us about the regional map.",
  },
  {
    showSlug: "whats-your-number",
    slug: "zero-point-eight",
    title: "0.8",
    publishedAt: "2026-04-08",
    durationMinutes: 10,
    description:
      "A coalition number masquerading as a polling number. We unpack it.",
  },

  // Ark News Daily
  {
    showSlug: "ark-news-daily",
    slug: "april-29",
    title: "Tuesday, April 29 — the Cairo readout",
    publishedAt: "2026-04-29",
    durationMinutes: 9,
    description: "The single news item that matters today, explained in nine minutes.",
  },
  {
    showSlug: "ark-news-daily",
    slug: "april-28",
    title: "Monday, April 28 — coalition signals",
    publishedAt: "2026-04-28",
    durationMinutes: 8,
    description: "What yesterday's polling actually said, in eight minutes.",
  },
  {
    showSlug: "ark-news-daily",
    slug: "april-25",
    title: "Friday, April 25 — the IDF reorg",
    publishedAt: "2026-04-25",
    durationMinutes: 10,
    description: "A structural change inside the IDF, explained.",
  },
  {
    showSlug: "ark-news-daily",
    slug: "april-24",
    title: "Thursday, April 24 — the campus picture",
    publishedAt: "2026-04-24",
    durationMinutes: 9,
    description: "What the spring numbers say about American campus politics.",
  },
];

export function episodesForShow(showSlug: ShowSlug): Episode[] {
  return episodes.filter((e) => e.showSlug === showSlug);
}

export function getEpisode(showSlug: ShowSlug, slug: string): Episode | undefined {
  return episodes.find((e) => e.showSlug === showSlug && e.slug === slug);
}

export function formatEpisodeDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}
