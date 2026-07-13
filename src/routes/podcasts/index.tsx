import { createFileRoute, Link } from "@tanstack/react-router";
import { shows } from "../../data/shows";
import { PageShell } from "../../components/PageShell";
import { ShowCover } from "../../components/ShowCover";
import { GRID_IMAGE_SIZES } from "../../lib/images";
import { ClampedText } from "../../components/ClampedText";
import { useShowDescriptions } from "../../lib/useShowDescription";

export const Route = createFileRoute("/podcasts/")({
  component: ShowsHub,
});

function ShowsHub() {
  const descriptions = useShowDescriptions(shows.map((s) => s.slug));
  return (
    <PageShell
      title="Four shows. One newsroom."
      lede="Long-form interviews, fast briefs, and ongoing conversations on the questions that matter."
    >
      <section>
        <div className="page-section">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
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
                  sizes={GRID_IMAGE_SIZES}
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
        </div>
      </section>
    </PageShell>
  );
}
