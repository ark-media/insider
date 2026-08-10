import { formatCalendarDate } from "../../shared/format-date";
import type { SanitizedHtml } from "../../shared/sanitized-html";

export type NewsletterSlug = "ark-daily" | "members-letter";

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
   * produce HTML (e.g. Circle Broadcasts, Beehiiv) populate this; plain-text
   * sources leave it undefined. Branded as SanitizedHtml so a renderer can
   * type its input narrowly and a caller can't quietly hand it raw HTML.
   */
  bodyHtml?: SanitizedHtml;
  tier: "free" | "ark-plus";
  authorName: string;
  /**
   * Source-system identifier for the post (currently a Beehiiv post id). Set
   * server-side for posts that came from Beehiiv so the read path can join
   * the discuss-threads mapping table; undefined for Circle-sourced posts.
   */
  beehiivPostId?: string;
  /**
   * Companion Circle thread URL when one has been minted from /admin. The
   * post page surfaces this as the "Discuss on forum →" button.
   */
  discussUrl?: string;
};

export const newsletters: Newsletter[] = [
  {
    slug: "ark-daily",
    title: "The Ark Media Newsletter",
    shortTitle: "Ark Media",
    description:
      "Our free dispatch — the through-lines from this week's interviews and what they tell us about the week ahead.",
    cadence: "Weekly",
    tier: "free",
    authorName: "Ark Media newsroom",
  },
  {
    slug: "members-letter",
    title: "The Ark+ Members Letter",
    shortTitle: "Members Letter",
    description:
      "A members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading.",
    cadence: "Weekly",
    tier: "ark-plus",
    authorName: "Ark Media editorial",
  },
];

export function getNewsletter(slug: string): Newsletter | undefined {
  return newsletters.find((n) => n.slug === slug);
}

/** Beehiiv publication slugs — not post slugs. Used to redirect legacy URLs. */
export function isNewsletterPublicationSlug(s: string): s is NewsletterSlug {
  return s === "ark-daily" || s === "members-letter";
}

/** Which newsletter surface a reader should see on /newsletters. */
export function newsletterSlugForReader(isArkPlusSubscriber: boolean): NewsletterSlug {
  return isArkPlusSubscriber ? "members-letter" : "ark-daily";
}

// Beehiiv issue dates arrive as 'YYYY-MM-DD' — a calendar date, so format it
// timezone-free rather than letting local time slide it back a day.
export function formatPostDate(iso: string): string {
  return formatCalendarDate(iso, "long");
}
