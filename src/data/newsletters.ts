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
  /**
   * Sanitized HTML body. When present, the post renderer prefers this over
   * `body` and parses it through html-react-parser. Sources that natively
   * produce HTML (e.g. Circle Broadcasts) populate this; plain-text sources
   * leave it undefined.
   */
  bodyHtml?: string;
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

export function getNewsletter(slug: string): Newsletter | undefined {
  return newsletters.find((n) => n.slug === slug);
}

export function formatPostDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
