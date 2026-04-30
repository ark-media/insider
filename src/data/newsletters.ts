export type NewsletterSlug =
  | "the-call-me-back-newsletter"
  | "ark-daily"
  | "for-heavens-sake-newsletter"
  | "members-letter";

export type Newsletter = {
  slug: NewsletterSlug;
  title: string;
  shortTitle: string;
  description: string;
  cadence: string;
  /** Free issues land in inboxes; paid issues are gated for Ark+ on the web. */
  tier: "free" | "ark-plus";
  authorName: string;
};

export type NewsletterPost = {
  newsletterSlug: NewsletterSlug;
  slug: string;
  title: string;
  publishedAt: string;
  /** ~1-sentence summary shown in the listing */
  excerpt: string;
  /** Full body — markdown-ish; rendered in a templated reading view */
  body: string;
  tier: "free" | "ark-plus";
  authorName: string;
};

export const newsletters: Newsletter[] = [
  {
    slug: "the-call-me-back-newsletter",
    title: "The Call Me Back Newsletter",
    shortTitle: "Call Me Back",
    description:
      "Dan Senor's weekly dispatch — the through-lines from this week's interviews and what they tell us about the week ahead.",
    cadence: "Sundays",
    tier: "free",
    authorName: "Dan Senor",
  },
  {
    slug: "ark-daily",
    title: "Ark Daily",
    shortTitle: "Ark Daily",
    description:
      "Ten lines on the day's most consequential story, from the Ark Media newsroom.",
    cadence: "Weekdays, 7:00 AM ET",
    tier: "free",
    authorName: "Ark Media newsroom",
  },
  {
    slug: "for-heavens-sake-newsletter",
    title: "For Heaven's Sake Letter",
    shortTitle: "For Heaven's Sake",
    description:
      "Donniel and Yossi's monthly letter — slower, longer, and unedited.",
    cadence: "Monthly",
    tier: "free",
    authorName: "Donniel Hartman & Yossi Klein Halevi",
  },
  {
    slug: "members-letter",
    title: "The Members Letter",
    shortTitle: "Members Letter",
    description:
      "A weekly Ark+ members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading.",
    cadence: "Thursdays",
    tier: "ark-plus",
    authorName: "Ark Media editorial",
  },
];

export const newsletterPosts: NewsletterPost[] = [
  {
    newsletterSlug: "the-call-me-back-newsletter",
    slug: "the-week-in-numbers",
    title: "The week in numbers",
    publishedAt: "2026-04-27",
    excerpt:
      "What the polling, the bond market, and the IDF reorg have in common — and what they don't.",
    body:
      "We had three big things this week, and they don't fit on the same page. The polling. The bond market move. The IDF reorg. The temptation is to weave them into a single narrative. They aren't a single narrative. They're three different signals from three different systems, and the fact that they all point in the same direction is partly coincidence and partly a story about how the country processes a political moment...",
    tier: "free",
    authorName: "Dan Senor",
  },
  {
    newsletterSlug: "the-call-me-back-newsletter",
    slug: "what-i-got-wrong",
    title: "What I got wrong",
    publishedAt: "2026-04-20",
    excerpt:
      "A correction, a reframing, and a note on the limits of forecasting.",
    body:
      "Three weeks ago I argued that the coalition geometry would settle by April. It hasn't, and the reasons are interesting...",
    tier: "free",
    authorName: "Dan Senor",
  },
  {
    newsletterSlug: "the-call-me-back-newsletter",
    slug: "after-cairo",
    title: "After Cairo",
    publishedAt: "2026-04-13",
    excerpt:
      "What changed in the room, and what hasn't changed at all.",
    body:
      "The most important thing about Cairo this week wasn't the readout. It was the absence of one...",
    tier: "free",
    authorName: "Dan Senor",
  },
  {
    newsletterSlug: "ark-daily",
    slug: "april-29",
    title: "Tuesday, April 29",
    publishedAt: "2026-04-29",
    excerpt: "The Cairo readout, in ten lines.",
    body:
      "1. The readout came at 6:14am ET.\n2. The headline was the timeline; the news was the verbs...",
    tier: "free",
    authorName: "Ark Media newsroom",
  },
  {
    newsletterSlug: "ark-daily",
    slug: "april-28",
    title: "Monday, April 28",
    publishedAt: "2026-04-28",
    excerpt: "What the weekend polling actually said.",
    body:
      "The Sunday tracker had three numbers worth your time, and one number that's getting more attention than it deserves...",
    tier: "free",
    authorName: "Ark Media newsroom",
  },
  {
    newsletterSlug: "for-heavens-sake-newsletter",
    slug: "april-letter",
    title: "April letter",
    publishedAt: "2026-04-15",
    excerpt: "On solidarity, in a year that has tested it.",
    body:
      "Friends — this letter has been sitting in my drafts for ten days. The reason is the question. What does it mean to be in a Jewish people, in a year like this one?...",
    tier: "free",
    authorName: "Donniel Hartman & Yossi Klein Halevi",
  },
  {
    newsletterSlug: "members-letter",
    slug: "the-coalition-memo",
    title: "The coalition memo",
    publishedAt: "2026-04-24",
    excerpt:
      "An off-record briefing on coalition math, source notes included. Members only.",
    body:
      "This is the longer-form version of what we couldn't fit on the show. Three scenarios, the numbers behind each, and what to watch for in the next two weeks. Source notes at the bottom...",
    tier: "ark-plus",
    authorName: "Ark Media editorial",
  },
  {
    newsletterSlug: "members-letter",
    slug: "what-were-reading",
    title: "What we're reading — April",
    publishedAt: "2026-04-17",
    excerpt:
      "The pieces on our desks this week. Annotated. Members only.",
    body:
      "Six pieces, with notes on why we read each one and what to skip. Members only...",
    tier: "ark-plus",
    authorName: "Ark Media editorial",
  },
];

export function getNewsletter(slug: string): Newsletter | undefined {
  return newsletters.find((n) => n.slug === slug);
}

export function postsForNewsletter(slug: NewsletterSlug): NewsletterPost[] {
  return newsletterPosts.filter((p) => p.newsletterSlug === slug);
}

export function getNewsletterPost(
  newsletterSlug: NewsletterSlug,
  postSlug: string,
): NewsletterPost | undefined {
  return newsletterPosts.find(
    (p) => p.newsletterSlug === newsletterSlug && p.slug === postSlug,
  );
}

export function formatPostDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
