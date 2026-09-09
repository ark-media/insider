import { createFileRoute, Link } from "@tanstack/react-router";
import { shows } from "../../data/shows";
import { PageShell } from "../../components/PageShell";
import { ShowCover } from "../../components/ShowCover";
import { ClampedText } from "../../components/ClampedText";
import { ArkPlusMark } from "../../components/ArkPlusMark";
import { LatestEpisodes } from "../../components/LatestEpisodes";
import { useShowDescriptions } from "../../lib/useShowDescription";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";

// Two-up on phones, three-up from `md`, four-up from `lg` — where the 80rem
// container puts each cover at ~285px rather than the ~380px a three-up row
// gave it.
const BROWSE_GRID_SIZES =
  "(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw";

export const Route = createFileRoute("/podcasts/")({
  component: ShowsHub,
});

function ShowsHub() {
  const descriptions = useShowDescriptions(shows.map((s) => s.slug));
  return (
    <PageShell
      title="News, debate, history, and everything in between."
      lede="Honest conversations about Jewish life, both big and small."
    >
      <LatestEpisodes />
      <section>
        <div className="page-section">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {shows.map((show) => (
              <Link
                key={show.slug}
                to={show.route}
                className="group relative block overflow-hidden border border-rule bg-navy-800/40 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                {show.paid ? (
                  <span className="label absolute right-4 top-4 z-10 border border-cyan/60 bg-navy-900/80 px-2 py-0.5 text-cyan backdrop-blur-sm">
                    Ark+
                  </span>
                ) : null}
                <ShowCover
                  show={show}
                  sizes={BROWSE_GRID_SIZES}
                  className="border-b border-rule"
                />
                <div className="p-4 sm:p-6">
                  <h2 className="font-display text-[17px] leading-[1.15] text-fg-strong sm:text-[22px]">
                    {show.title}
                  </h2>
                  {/* Two-up on phones leaves a ~130px text column — too narrow to
                      read a description in. The art and title carry the browse
                      grid; the copy returns once the card has width for it.
                      `sr-only`, not `hidden`: the description is redundant to
                      the eye at this width, not to a screen reader, so it stays
                      in the accessibility tree. Neither sets `display`, which is
                      what preserves line-clamp's `-webkit-box` — `hidden
                      sm:block` would clobber it and unclamp the copy above the
                      phone breakpoint. */}
                  <ClampedText
                    text={descriptions[show.slug] || show.tagline}
                    className="mt-3 line-clamp-3 text-body-sm max-sm:sr-only"
                  />
                  {/* eyebrow's 14px + 0.22em tracking wraps the arrow onto its
                      own line in a two-up phone column — tightened until there's
                      room for the full treatment. */}
                  <div className="mt-4 eyebrow text-[11px] tracking-[0.1em] text-fg-faint transition group-hover:text-cyan sm:mt-6 sm:text-xs sm:tracking-eyebrow">
                    Visit show →
                  </div>
                </div>
              </Link>
            ))}
          </div>
          <ArkPlusCallout />
        </div>
      </section>
    </PageShell>
  );
}

/**
 * Membership pitch under the grid. Hidden from paid members (nothing to sell
 * them) and while the session is still resolving, so a member never sees it
 * flash in and out. A signed-in free user still gets it — `kind: "member"` is
 * not the same as paid.
 */
function ArkPlusCallout() {
  const { state } = useSubscriberAuth();
  if (state.kind === "loading" || isArkPlusMember(state)) return null;

  return (
    <div className="mt-12 border border-rule bg-navy-800/40 p-6 sm:mt-16 sm:p-8">
      <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <div className="flex items-center gap-4">
            <ArkPlusMark className="h-12 w-12" />
            <div className="label text-cyan">Ark+</div>
          </div>
          <p className="mt-3 max-w-2xl text-body-lg">
            Ark+ subscribers fund honest coverage of Israel and Jewish life. Get
            ad-free listening and exclusive content across every show.
          </p>
        </div>
        <div className="lg:col-span-4 lg:text-right">
          <Link
            to="/plus"
            className="inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Subscribe →
          </Link>
        </div>
      </div>
    </div>
  );
}
