import { createFileRoute, Link } from "@tanstack/react-router";
import { shows } from "../../data/shows";
import { PageShell } from "../../components/PageShell";
import { ShowCover } from "../../components/ShowCover";
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                <ShowCover show={show} className="border-b border-rule" />
                <div className="p-6">
                  <h2 className="font-display text-[22px] leading-[1.15] text-fg-strong">
                    {show.title}
                  </h2>
                  <ClampedText
                    text={descriptions[show.slug] || show.tagline}
                    className="mt-3 line-clamp-3 text-body-sm"
                  />
                  <div className="mt-6 eyebrow text-fg-faint transition group-hover:text-cyan">
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
