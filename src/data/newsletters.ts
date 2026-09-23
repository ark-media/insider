import { formatCalendarDate } from "../../shared/format-date.js";
import type { SanitizedHtml } from "../../shared/sanitized-html.js";

// One newsletter. Free and paid readers get different editions of the same
// issue — Beehiiv's premium tier sees the members-only sections, everyone else
// the free ones — so there is no second list to pick between. The slug keeps
// its original name because it keys BEEHIIV_PUBLICATION_ID_ARK_DAILY.
export type NewsletterSlug = "ark-daily";

export type Newsletter = {
  slug: NewsletterSlug;
  title: string;
  shortTitle: string;
  description: string;
  cadence: string;
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

export const newsletter: Newsletter = {
  slug: "ark-daily",
  title: "The Ark Media Newsletter",
  shortTitle: "Ark Media",
  description:
    "The through-lines from this week's interviews and what they tell us about the week ahead. Ark+ members get the members' edition, with sharper analysis and source notes.",
  cadence: "Weekly",
  authorName: "Ark Media newsroom",
};

// Beehiiv issue dates arrive as 'YYYY-MM-DD' — a calendar date, so format it
// timezone-free rather than letting local time slide it back a day.
export function formatPostDate(iso: string): string {
  return formatCalendarDate(iso, "long");
}
