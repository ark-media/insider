import type { BookClubPick } from "../data/bookClub";

/**
 * Portrait (2:3) book cover. Uses the uploaded `coverArt` when present; until
 * real art lands in `public/book-club/`, picks fall back to a branded
 * placeholder panel carrying the title + author — the v1 state.
 *
 * Callers size the cover with `className` on the outer box (e.g. `w-full` in a
 * grid cell, a `max-w-xs` in the hero). Pass `priority` for the above-the-fold
 * featured cover so it isn't lazy-loaded.
 */
export function BookCover({
  book,
  className,
  priority = false,
}: {
  book: BookClubPick;
  className?: string;
  priority?: boolean;
}) {
  const box = `relative aspect-[2/3] overflow-hidden ${className ?? ""}`;

  if (book.coverArt) {
    return (
      <div className={box}>
        <img
          src={book.coverArt}
          alt={`${book.title} by ${book.author} — cover`}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          className="h-full w-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={`${book.title} by ${book.author} — cover art`}
      className={`${box} border border-rule bg-gradient-to-br from-navy-800/80 via-navy-700/40 to-navy-900/80`}
    >
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 60% 50% at 30% 25%, rgb(62 181 249 / 0.4) 0%, transparent 60%)",
        }}
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="eyebrow text-cyan">Ark Book Club</div>
        <div className="display-upright text-[clamp(1.3rem,2.2vw,1.9rem)] leading-[1.05] text-fg-strong">
          {book.title}
        </div>
        <div className="text-body-sm text-fg-muted">{book.author}</div>
      </div>
    </div>
  );
}
