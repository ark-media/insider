import { createFileRoute, Link } from "@tanstack/react-router";
import { shows } from "../../data/shows";
import { PageShell } from "../../components/PageShell";

export const Route = createFileRoute("/shows/")({
  component: ShowsHub,
});

function ShowsHub() {
  return (
    <PageShell
      eyebrow="Shows"
      title="Five shows from Ark Media."
      lede="Long-form interviews, fast briefs, and ongoing conversations on the questions that matter."
    >
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shows.map((show) => (
              <Link
                key={show.slug}
                to={show.route}
                className="group relative block border border-white/12 bg-navy-800/40 p-6 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                {show.paid ? (
                  <span className="absolute right-4 top-4 border border-cyan/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan">
                    Ark+
                  </span>
                ) : null}
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  {show.shortTitle}
                </div>
                <div className="mt-4 font-display text-[22px] leading-[1.15] text-white">
                  {show.title}
                </div>
                <p className="mt-3 text-[13px] leading-[1.6] text-white/60">
                  {show.tagline}
                </p>
                <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45 transition group-hover:text-cyan">
                  Visit show →
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}
