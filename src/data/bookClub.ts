// ---------------------------------------------------------------------------
// Dan's Book Club — content model. One pick a month, twelve a year, chosen by
// Dan and read alongside the Fold. Follows the site's data-file convention
// (exported type + records array + accessor helpers), mirroring shows.ts.
//
// Buying is Amazon-affiliate only. Each book carries the per-format affiliate
// links Amazon's SiteStripe generates (amzn.to short links, already tagged);
// the first one listed is the edition the main buy button goes to. A book with
// no links yet falls back to a tagged `/dp/<ASIN>` URL built by `amazonUrl()`.
// No Product Advertising API — a dozen static links a year don't need it.
//
// Covers: drop a portrait image in `public/book-club/` and set `coverArt`.
// Picks without one render a branded placeholder (see BookCover).
//
// Everything is driven by the calendar (America/New_York), so nothing has to be
// moved or re-flagged by hand as months turn over:
//   - the current pick is the latest one whose month has started (before the
//     club begins, the first pick stands in);
//   - a future pick goes "on deck" on the 15th of the month before it — that's
//     when it's announced — and stays hidden until then;
//   - picks whose month is behind the current one become past picks.
// Adding next year's books ahead of time is safe: they stay hidden until their
// announcement date.
// ---------------------------------------------------------------------------

import { calendarDateInZone } from "../../shared/format-date";

/** Amazon Associates tracking tag — the same one the amzn.to links carry. */
const ARK_ASSOC_TAG = "danbookclub-20";

/** Day of the month before a pick's month on which that pick is announced. */
const ANNOUNCE_DAY = 15;

/** Timezone the club's calendar runs on. */
const CLUB_TIME_ZONE = "America/New_York";

export type BookFormat = "Hardcover" | "Paperback" | "Kindle" | "Audiobook";

/** One affiliate link per edition. */
export type BuyLink = { format: BookFormat; url: string };

export type BookClubPick = {
  slug: string;
  title: string;
  /** The book's subtitle, shown under the title where there's room for it. */
  subtitle?: string;
  author: string;
  /** Pick month as `YYYY-MM`. Drives ordering, the "July '26 Pick" badge, and
   *  when the pick is current, announced, or past (see the header comment). */
  month: string;
  /** Portrait (2:3) cover from `/public/book-club/`. Absent → placeholder art. */
  coverArt?: string;
  /** Dan's note on why he picked it — the personality that makes people care. */
  danNote: string;
  /** Amazon ASIN (the `/dp/<ASIN>` id). Fallback when `buyLinks` is empty. */
  amazonAsin: string;
  /** Affiliate links per edition; the first is the main buy button's target. */
  buyLinks?: BuyLink[];
};

/** Build a tagged Amazon product URL from an ASIN. */
export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}/?tag=${ARK_ASSOC_TAG}`;
}

/** Where to buy a book: its affiliate links, or one tagged ASIN link (no
 *  format label, since we don't know which edition the ASIN is). */
export function getBuyLinks(book: {
  amazonAsin: string;
  buyLinks?: BuyLink[];
}): { format?: BookFormat; url: string }[] {
  return book.buyLinks && book.buyLinks.length > 0
    ? book.buyLinks
    : [{ url: amazonUrl(book.amazonAsin) }];
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
// Add `buyLinks` to each pick as its SiteStripe links come in.
const bookClubPicks: BookClubPick[] = [
  {
    slug: "the-pity-of-it-all",
    title: "The Pity of It All",
    subtitle: "A Portrait of the German-Jewish Epoch, 1743–1933",
    author: "Amos Elon",
    month: "2026-10",
    coverArt: "/book-club/the-pity-of-it-all.jpg",
    danNote:
      "PLACEHOLDER — two centuries of German Jews building a country's culture while being told they could never quite belong to it. Elon writes the whole arc without ever letting you forget how it ends. I can't think of a better book to start with.",
    amazonAsin: "0312422814",
    buyLinks: [
      { format: "Paperback", url: "https://amzn.to/4rwDccK" },
      { format: "Hardcover", url: "https://amzn.to/4hkRDLZ" },
      { format: "Kindle", url: "https://amzn.to/4iExP8R" },
    ],
  },
  {
    slug: "the-cauldron",
    title: "The Cauldron",
    subtitle: "The Making of the Modern Middle East",
    author: "Simon Sebag Montefiore",
    month: "2026-11",
    coverArt: "/book-club/the-cauldron.jpg",
    danNote:
      "PLACEHOLDER — the long backstory to almost everything we cover on Call Me Back, told by someone who can move a century along without losing the people inside it. Read this and the headlines stop arriving out of nowhere.",
    amazonAsin: "0593805054",
  },
  {
    slug: "submission",
    title: "Submission",
    author: "Michel Houellebecq",
    month: "2026-12",
    coverArt: "/book-club/submission.jpg",
    danNote:
      "PLACEHOLDER — a novel about a France too tired to argue for itself. Plenty of people in the Fold will hate it, which is exactly why it's here: fiction gets at the mood underneath the politics in a way reporting rarely does.",
    amazonAsin: "1250097347",
  },
  {
    slug: "american-pastoral",
    title: "American Pastoral",
    author: "Philip Roth",
    month: "2027-01",
    coverArt: "/book-club/american-pastoral.jpg",
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
  /** Affiliate links per edition; the first is the main buy button's target. */
  buyLinks?: BuyLink[];
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
    buyLinks: [
      { format: "Hardcover", url: "https://amzn.to/4hbBJFe" },
      { format: "Kindle", url: "https://amzn.to/4AvcdSQ" },
      { format: "Audiobook", url: "https://amzn.to/4h8bWh5" },
    ],
  },
  {
    slug: "start-up-nation",
    title: "Start-Up Nation",
    subtitle: "The Story of Israel's Economic Miracle",
    author: "Dan Senor & Saul Singer",
    coverArt: "/book-club/start-up-nation.png",
    note: "Start-Up Nation addresses the trillion dollar question: How is it that Israel — a country of 7.1 million, only 60 years old, surrounded by enemies, in a constant state of war since its founding, with no natural resources — produces more start-up companies than large, peaceful, and stable nations like Japan, China, India, Korea, Canada and the UK?",
    amazonAsin: "044654146X",
    buyLinks: [
      { format: "Hardcover", url: "https://amzn.to/4jpCLP4" },
      { format: "Paperback", url: "https://amzn.to/4iLsQTR" },
      { format: "Kindle", url: "https://amzn.to/4hojhYQ" },
      { format: "Audiobook", url: "https://amzn.to/4xCty9T" },
    ],
  },
];

/** Today's date in the club's timezone, as `YYYY-MM-DD`. */
function clubToday(): string {
  return calendarDateInZone(Date.now(), CLUB_TIME_ZONE);
}

/** `"2026-11"` → `"2026-10-15"`: the date a pick is announced. */
export function announceDate(month: string): string {
  const [year, mo] = month.split("-").map(Number);
  const prevYear = mo === 1 ? year - 1 : year;
  const prevMonth = mo === 1 ? 12 : mo - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}-${ANNOUNCE_DAY}`;
}

const byMonth = [...bookClubPicks].sort((a, b) =>
  a.month.localeCompare(b.month),
);

/** The pick being read now: the latest whose month has started, or the first
 *  pick before the club begins. `today` is `YYYY-MM-DD`; tests pass it. */
export function getCurrentPick(
  today: string = clubToday(),
): BookClubPick | undefined {
  const thisMonth = today.slice(0, 7);
  return byMonth.filter((b) => b.month <= thisMonth).at(-1) ?? byMonth[0];
}

/** Announced picks after the current one, in the order we'll read them. */
export function getUpcomingPicks(today: string = clubToday()): BookClubPick[] {
  const current = getCurrentPick(today);
  if (!current) return [];
  return byMonth.filter(
    (b) => b.month > current.month && announceDate(b.month) <= today,
  );
}

/** Picks already read — everything before the current one, newest first. */
export function getPastPicks(today: string = clubToday()): BookClubPick[] {
  const current = getCurrentPick(today);
  if (!current) return [];
  return byMonth.filter((b) => b.month < current.month).reverse();
}
