// ---------------------------------------------------------------------------
// Dan's Book Club — content model. One pick a month, twelve a year, chosen by
// Dan and read alongside the Fold. Follows the site's data-file convention
// (exported type + records array + accessor helpers), mirroring shows.ts.
//
// Buying is Amazon-affiliate only for v1: store the ASIN per book and build the
// tagged URL centrally via `amazonUrl()` so the Associates tag lives in exactly
// one place. No Product Advertising API — twelve static links a year don't need
// it, and PA-API access is gated behind ongoing qualifying sales.
//
// Covers: drop a portrait image in `public/book-club/` and set `coverArt`.
// Picks without one render a branded placeholder (see BookCover).
//
// The club hasn't started yet, so the catalogue below is the first four picks
// and every one of them is still ahead of us: `getUpcomingPicks()` carries the
// page for now, and `getPastPicks()` fills in on its own as months fall behind
// the featured pick. Nothing has to move between arrays by hand.
// ---------------------------------------------------------------------------

/** Amazon Associates tracking tag. Placeholder — replace with the real tag
 *  once the Associates account is approved, before launch. */
const ARK_ASSOC_TAG = "arkmedia-20";

export type BookClubPick = {
  slug: string;
  title: string;
  /** The book's subtitle, shown under the title where there's room for it. */
  subtitle?: string;
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

// Dan's first four picks. Titles, authors and ASINs are final; the notes are
// drafts in Dan's voice and stay marked PLACEHOLDER until he writes his own.
const bookClubPicks: BookClubPick[] = [
  {
    slug: "the-pity-of-it-all",
    title: "The Pity of It All",
    subtitle: "A Portrait of the German-Jewish Epoch, 1743–1933",
    author: "Amos Elon",
    month: "2026-10",
    danNote:
      "PLACEHOLDER — two centuries of German Jews building a country's culture while being told they could never quite belong to it. Elon writes the whole arc without ever letting you forget how it ends. I can't think of a better book to start with.",
    amazonAsin: "0312422814",
    featured: true,
  },
  {
    slug: "the-cauldron",
    title: "The Cauldron",
    subtitle: "The Making of the Modern Middle East",
    author: "Simon Sebag Montefiore",
    month: "2026-11",
    danNote:
      "PLACEHOLDER — the long backstory to almost everything we cover on Call Me Back, told by someone who can move a century along without losing the people inside it. Read this and the headlines stop arriving out of nowhere.",
    amazonAsin: "0593805054",
  },
  {
    slug: "submission",
    title: "Submission",
    author: "Michel Houellebecq",
    month: "2026-12",
    danNote:
      "PLACEHOLDER — a novel about a France too tired to argue for itself. Plenty of people in the Fold will hate it, which is exactly why it's here: fiction gets at the mood underneath the politics in a way reporting rarely does.",
    amazonAsin: "1250097347",
  },
  {
    slug: "american-pastoral",
    title: "American Pastoral",
    author: "Philip Roth",
    month: "2027-01",
    danNote:
      "PLACEHOLDER — Roth on a man who did everything right and watched the ground open under him anyway. Assimilation, political violence, and what parents owe their children. We'll have plenty to argue about.",
    amazonAsin: "0375701427",
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

/** Picks scheduled after the featured one, in the order we'll read them. */
export function getUpcomingPicks(): BookClubPick[] {
  const current = getCurrentPick();
  if (!current) return [];
  return bookClubPicks
    .filter((b) => b !== current && b.month > current.month)
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Picks already read — everything before the featured one, newest month first. */
export function getPastPicks(): BookClubPick[] {
  const current = getCurrentPick();
  if (!current) return [];
  return bookClubPicks
    .filter((b) => b !== current && b.month < current.month)
    .sort((a, b) => b.month.localeCompare(a.month));
}
