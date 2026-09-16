import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  amazonUrl,
  danBooks,
  formatPickMonth,
  getCurrentPick,
  getPastPicks,
  type AuthoredBook,
  type BookClubPick,
} from "../data/bookClub";
import { BookCover } from "../components/BookCover";
import { Modal } from "../components/Modal";
import { trackEvent } from "../lib/analytics";

export const Route = createFileRoute("/book-club")({
  component: BookClubPage,
});

const BUY_BUTTON_CLASS =
  "group inline-flex min-h-12 items-center justify-between gap-8 bg-cyan px-5 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

function BuyOnAmazon({
  book,
  className,
}: {
  book: Pick<BookClubPick | AuthoredBook, "slug" | "amazonAsin">;
  className?: string;
}) {
  return (
    <a
      href={amazonUrl(book.amazonAsin)}
      target="_blank"
      rel="noreferrer noopener sponsored"
      onClick={() => trackEvent("book_link_clicked", { slug: book.slug })}
      className={`${BUY_BUTTON_CLASS} ${className ?? ""}`}
    >
      Buy on Amazon
      <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
        →
      </span>
    </a>
  );
}

function BookClubPage() {
  const current = getCurrentPick();
  const past = getPastPicks();
  const [selected, setSelected] = useState<BookClubPick | null>(null);

  return (
    <>
      {/* Hero */}
      <section className="section-hero relative">
        <div className="page-gutter pt-16 pb-4 text-center">
          <div className="eyebrow">Dan's Book Club</div>
          <h1 className="mx-auto mt-4 max-w-3xl text-h1">
            A book club worth{" "}
            <span className="display text-cyan">showing up</span> for.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-body-lg text-fg">
            One standout book a month, handpicked by Dan — and the Fold reading
            along, digging in, and arguing it out. Big ideas, sharp debate, and
            a conversation you'll actually want to be part of.
          </p>
        </div>
      </section>

      {/* Current pick */}
      {current ? (
        <section className="relative border-t border-rule-soft">
          <div className="page-gutter pt-12 pb-16">
            <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:gap-12">
              <div className="mx-auto w-full max-w-xs lg:col-span-4 lg:mx-0">
                <BookCover book={current} priority />
              </div>
              <div className="lg:col-span-8">
                <div className="eyebrow text-cyan">
                  {formatPickMonth(current.month)} Pick
                </div>
                <h2 className="mt-4 text-fg-strong">
                  <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)] leading-[1.05]">
                    {current.title}
                  </span>
                </h2>
                <p className="mt-2 text-body-lg text-fg-muted">
                  {current.author}
                </p>
                <p className="mt-6 max-w-2xl text-body-lg text-fg">
                  {current.danNote}
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <BuyOnAmazon book={current} />
                  <Link
                    to="/fold"
                    onClick={() => trackEvent("book_club_join_clicked")}
                    className="group inline-flex min-h-12 items-center gap-2 button-text font-display font-bold tracking-cta text-cyan transition hover:text-fg-strong"
                  >
                    Discuss it in the Fold
                    <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
                      →
                    </span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* Past picks */}
      {past.length > 0 ? (
        <section className="relative border-t border-rule-soft">
          <div className="page-gutter pt-12 pb-16">
            <div className="eyebrow text-cyan">The shelf</div>
            <h2 className="mt-5 max-w-2xl text-fg-strong">
              <span className="display-upright block text-[clamp(1.7rem,3.5vw,2.8rem)]">
                Every pick so far.
              </span>
            </h2>

            <ul className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
              {past.map((book) => (
                <li key={book.slug}>
                  <button
                    type="button"
                    onClick={() => setSelected(book)}
                    aria-label={`${book.title} by ${book.author} — view details and buy`}
                    className="group relative block w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    <BookCover
                      book={book}
                      className="w-full transition group-hover:opacity-90"
                    />
                    {/* Month ribbon, overlaid on the cover's lower edge. */}
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-cyan/95 px-2 py-2 text-center font-display text-[12px] font-bold uppercase tracking-button text-navy sm:text-[13px]">
                      {formatPickMonth(book.month)} Pick
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {/* Books by Dan — his own titles, shown outside the monthly rotation. */}
      {danBooks.length > 0 ? (
        <section className="relative border-t border-rule-soft">
          <div className="page-gutter pt-12 pb-16">
            <h2 className="max-w-2xl text-fg-strong">
              <span className="display-upright block text-[clamp(1.7rem,3.5vw,2.8rem)]">
                Books by Dan
              </span>
            </h2>

            <ul className="mt-10 grid grid-cols-1 gap-10 sm:grid-cols-2">
              {danBooks.map((book) => (
                <li
                  key={book.slug}
                  className="grid grid-cols-[minmax(0,140px)_1fr] items-start gap-6"
                >
                  <BookCover book={book} className="w-full" />
                  <div>
                    <h3 className="display-upright text-[clamp(1.3rem,2.2vw,1.8rem)] leading-[1.1] text-fg-strong">
                      {book.title}
                    </h3>
                    {book.subtitle ? (
                      <p className="mt-2 text-body-sm text-fg-muted">
                        {book.subtitle}
                      </p>
                    ) : null}
                    <p className="mt-2 text-body-sm text-fg-muted">
                      {book.author}
                    </p>
                    <p className="mt-4 text-body-sm text-fg">{book.note}</p>
                    <BuyOnAmazon book={book} className="mt-6" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {/* Pick detail — opened by clicking a cover in the shelf. Shows the note
          and the two actions: buy it, or take it into the Fold. */}
      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        className="max-w-2xl"
        labelledBy="book-detail-title"
      >
        {selected ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-[minmax(0,180px)_1fr] sm:gap-8">
            <div className="mx-auto w-36 sm:mx-0 sm:w-full">
              <BookCover book={selected} />
            </div>
            <div>
              <div className="eyebrow text-cyan">
                {formatPickMonth(selected.month)} Pick
              </div>
              <h2
                id="book-detail-title"
                className="display-upright mt-3 text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.05] text-fg-strong"
              >
                {selected.title}
              </h2>
              <p className="mt-2 text-body-lg text-fg-muted">
                {selected.author}
              </p>
              <p className="mt-5 text-body-sm text-fg">{selected.danNote}</p>
              <div className="mt-6 flex flex-col gap-3">
                <BuyOnAmazon book={selected} className="w-full" />
                <Link
                  to="/fold"
                  onClick={() => trackEvent("book_club_join_clicked")}
                  className="group inline-flex min-h-12 w-full items-center justify-between border border-rule-strong px-5 button-text font-display font-bold tracking-cta text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Discuss it in the Fold
                  <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
                    →
                  </span>
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
