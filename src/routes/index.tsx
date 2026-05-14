import { createFileRoute, Link } from "@tanstack/react-router";
import { shows } from "../data/shows";
import { LinkCard, NumberedRow } from "../components/ContentCard";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const sections = [
  {
    number: "01",
    eyebrow: "Newsletters",
    title: "In your inbox.",
    to: "/newsletters",
    body: "Curated dispatches from the Ark Media newsroom — free letters and members-only editions.",
  },
  {
    number: "02",
    eyebrow: "Community",
    title: "In the room.",
    to: "/community",
    body: "The Ark+ community — Dan, Donniel, and Yossi in conversation with members.",
  },
  {
    number: "03",
    eyebrow: "Ark+",
    title: "All in.",
    to: "/plus",
    body: "One membership for the paid feed, members-only newsletters, and the community.",
  },
];

function HomePage() {
  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-20 sm:px-10 sm:pt-20">
          <p className="inside-tab rise rise-1 text-[12px]">Ark Media</p>
          <h1 className="mt-10 max-w-4xl text-fg-strong">
            <span className="rise rise-2 display-upright block text-[clamp(2.4rem,6vw,4.6rem)] leading-[1.02]">
              Long-form journalism
            </span>
            <span className="rise rise-3 display-upright block text-[clamp(2.4rem,6vw,4.6rem)] leading-[1.02]">
              for the{" "}
              <span className="display text-cyan">conversation</span>
            </span>
            <span className="rise rise-4 display-upright block text-[clamp(2.4rem,6vw,4.6rem)] leading-[1.02]">
              that matters.
            </span>
          </h1>
          <div
            aria-hidden="true"
            className="draw-rule mt-10 h-px w-24 origin-left bg-cyan"
            style={{ animationDelay: "0.7s" }}
          />
          <p className="rise rise-5 mt-8 max-w-2xl text-[15px] leading-[1.65] text-fg">
            Podcasts, newsletters, and live events from Dan Senor and the Ark
            Media team. Independent reporting and serious conversations on
            Israel, the Middle East, and the world they're shaping.
          </p>
          <div
            className="rise mt-10 flex flex-wrap gap-3"
            style={{ animationDelay: "0.78s" }}
          >
            <Link
              to="/podcasts"
              className="inline-flex min-h-12 items-center gap-2 border border-cyan bg-cyan px-5 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Explore podcasts →
            </Link>
            <Link
              to="/plus"
              className="inline-flex min-h-12 items-center gap-2 border border-rule-strong px-5 font-display text-[12px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Become an Ark+ member
            </Link>
          </div>
        </div>
      </section>

      {/* Podcast row — card grid (good for browsing) */}
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="flex items-end justify-between">
            <div>
              <div className="eyebrow">Podcasts</div>
              <h2 className="mt-3 text-fg-strong">
                <span className="display-upright block text-[clamp(1.8rem,3.5vw,2.6rem)]">
                  Five shows.
                </span>
              </h2>
            </div>
            <Link
              to="/podcasts"
              className="hidden text-[12px] font-semibold uppercase tracking-button text-fg-muted transition hover:text-cyan sm:inline"
            >
              All podcasts →
            </Link>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shows.map((show) => (
              <LinkCard
                key={show.slug}
                to={show.route}
                eyebrow={show.shortTitle}
                title={show.title}
                body={show.tagline}
                cta="Visit show"
              />
            ))}
          </div>
        </div>
      </section>

      {/* Three sections — editorial numbered stack (visually distinct from cards above) */}
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="mb-8">
            <div className="eyebrow">Also from Ark Media</div>
          </div>
          <div>
            {sections.map((s) => (
              <NumberedRow
                key={s.to}
                number={s.number}
                title={
                  <>
                    <span className="eyebrow mr-3 align-middle">{s.eyebrow}</span>
                    {s.title}
                  </>
                }
                body={s.body}
                cta="Learn more"
                to={s.to}
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
