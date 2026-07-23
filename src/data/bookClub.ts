// ---------------------------------------------------------------------------
// Dan's Book Club — content model. One pick a month, twelve a year, chosen by
// Dan and read alongside the community. Follows the site's data-file convention
// (exported type + records array + accessor helpers), mirroring shows.ts.
//
// Buying is Amazon-affiliate only for v1: store the ASIN per book and build the
// tagged URL centrally via `amazonUrl()` so the Associates tag lives in exactly
// one place. No Product Advertising API — twelve static links a year don't need
// it, and PA-API access is gated behind ongoing qualifying sales.
//
// Covers: drop a portrait image in `public/book-club/` and set `coverArt`.
// Picks without one render a branded placeholder (see BookCover), which is the
// v1 state until Dan's real selections and art land.
// ---------------------------------------------------------------------------

/** Amazon Associates tracking tag. Placeholder — replace with the real tag
 *  once the Associates account is approved, before launch. */
export const ARK_ASSOC_TAG = "arkmedia-20";

export type BookClubPick = {
  slug: string;
  title: string;
  author: string;
  /** Pick month as `YYYY-MM`. Drives ordering and the "July '26 Pick" badge. */
  month: string;
  /** Portrait (2:3) cover from `/public/book-club/`. Absent → placeholder art. */
  coverArt?: string;
  /** Dan's note on why he picked it — the personality that makes people care. */
  danNote: string;
  /** Amazon ASIN (the `/dp/<ASIN>` id). Tagged URL is built by `amazonUrl()`. */
  amazonAsin: string;
  /** The current month's featured pick. Exactly one should be featured. */
  featured?: boolean;
};

/** Build a tagged Amazon product URL from an ASIN. */
export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}/?tag=${ARK_ASSOC_TAG}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `"2026-07"` → `"July '26"`. Manual parse to avoid Date/timezone drift. */
export function formatPickMonth(month: string): string {
  const [year, mo] = month.split("-");
  const name = MONTHS[Number(mo) - 1] ?? "";
  return `${name} '${year.slice(2)}`;
}

// Placeholder catalogue — real titles, so the page reads honestly, but Dan's
// notes and the featured selection are stand-ins to be swapped before launch.
export const bookClubPicks: BookClubPick[] = [
  {
    slug: "the-power-broker",
    title: "The Power Broker",
    author: "Robert A. Caro",
    month: "2026-07",
    danNote:
      "PLACEHOLDER — Caro's study of how power actually accrues and gets spent. I keep coming back to it whenever I want to understand the machinery behind the headlines. We'll take it slow.",
    amazonAsin: "0394720245",
    featured: true,
  },
  {
    slug: "thinking-fast-and-slow",
    title: "Thinking, Fast and Slow",
    author: "Daniel Kahneman",
    month: "2026-06",
    danNote:
      "PLACEHOLDER — the book that reframed how I read every poll, every forecast, every gut call. A useful antidote to a news cycle built on snap judgments.",
    amazonAsin: "0374533555",
  },
  {
    slug: "the-looming-tower",
    title: "The Looming Tower",
    author: "Lawrence Wright",
    month: "2026-05",
    danNote:
      "PLACEHOLDER — narrative history at its best, and essential context for so much of what we talk about on the show.",
    amazonAsin: "1400030846",
  },
  {
    slug: "team-of-rivals",
    title: "Team of Rivals",
    author: "Doris Kearns Goodwin",
    month: "2026-04",
    danNote:
      "PLACEHOLDER — leadership under impossible pressure. Worth reading for the temperament alone.",
    amazonAsin: "0743270754",
  },
  {
    slug: "sapiens",
    title: "Sapiens",
    author: "Yuval Noah Harari",
    month: "2026-03",
    danNote:
      "PLACEHOLDER — a big, argumentative sweep of a book. The community had plenty to disagree with, which is exactly the point.",
    amazonAsin: "0062316095",
  },
];

// ---------------------------------------------------------------------------
// Books by Dan — Dan's own titles, shown in their own section (not the monthly
// rotation). No month or "why I picked it" note; the note is in Dan's voice as
// the author. Covers behave exactly like picks: drop a 2:3 image in
// `public/book-club/` and set `coverArt`, else the branded placeholder renders.
// ---------------------------------------------------------------------------
export type AuthoredBook = {
  slug: string;
  title: string;
  /** The book's subtitle, shown under the title in the section. */
  subtitle?: string;
  author: string;
  coverArt?: string;
  /** Dan's note on the book, in his own voice as the author. */
  note: string;
  amazonAsin: string;
};

export const danBooks: AuthoredBook[] = [
  {
    slug: "the-genius-of-israel",
    title: "The Genius of Israel",
    subtitle:
      "The Surprising Resilience of a Divided Nation in a Turbulent World",
    author: "Dan Senor & Saul Singer",
    coverArt: "/book-club/the-genius-of-israel.png",
    note: "How has a small nation of 9 million people, forced to fight for its existence and security since its founding and riven by ethnic, religious, and economic divides, proven resistant to so many of the societal ills plaguing other wealthy democracies?",
    amazonAsin: "1982115769",
  },
  {
    slug: "start-up-nation",
    title: "Start-Up Nation",
    subtitle: "The Story of Israel's Economic Miracle",
    author: "Dan Senor & Saul Singer",
    coverArt: "/book-club/start-up-nation.png",
    note: "Start-Up Nation addresses the trillion dollar question: How is it that Israel — a country of 7.1 million, only 60 years old, surrounded by enemies, in a constant state of war since its founding, with no natural resources — produces more start-up companies than large, peaceful, and stable nations like Japan, China, India, Korea, Canada and the UK?",
    amazonAsin: "044654146X",
  },
];

/** The current month's featured pick. */
export function getCurrentPick(): BookClubPick | undefined {
  return bookClubPicks.find((b) => b.featured) ?? bookClubPicks[0];
}

/** Every non-featured pick, newest month first. */
export function getPastPicks(): BookClubPick[] {
  return bookClubPicks
    .filter((b) => !b.featured)
    .sort((a, b) => b.month.localeCompare(a.month));
}
