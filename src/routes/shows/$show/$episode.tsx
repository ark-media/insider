import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  formatDuration,
  formatEpisodeDate,
  type Episode,
} from "../../../data/episodes";
import { getShow, type ShowSlug } from "../../../data/shows";
import { getEpisode, simplecastEmbedSrc } from "../../../lib/simplecast";
import { PageShell } from "../../../components/PageShell";

export const Route = createFileRoute("/shows/$show/$episode")({
  loader: ({ params }) => {
    const show = getShow(params.show);
    if (!show) throw notFound();
    return { show };
  },
  component: EpisodePage,
});

function EpisodePage() {
  const { show } = Route.useLoaderData();
  const { episode: episodeSlug } = Route.useParams();
  const [episode, setEpisode] = useState<Episode | null | "loading">("loading");

  useEffect(() => {
    let live = true;
    void getEpisode(show.slug as ShowSlug, episodeSlug).then(
      (r) => live && setEpisode(r),
    );
    return () => {
      live = false;
    };
  }, [show.slug, episodeSlug]);

  if (episode === "loading") {
    return (
      <PageShell title="Loading…" lede=" ">
        <></>
      </PageShell>
    );
  }

  if (!episode) {
    return (
      <PageShell
        eyebrow={show.shortTitle}
        title="Episode not found."
        lede="We couldn't find that episode."
      >
        <section className="border-t border-white/10 bg-navy-900">
          <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
            <Link
              to={show.route}
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
            >
              ← Back to {show.title}
            </Link>
          </div>
        </section>
      </PageShell>
    );
  }

  const isPaid = show.paid;

  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-10 pb-12 sm:px-10 sm:pt-16">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            <Link to={show.route} className="transition hover:text-white">
              {show.shortTitle}
            </Link>{" "}
            · {formatEpisodeDate(episode.publishedAt)}
          </div>
          <h1 className="mt-8 max-w-3xl font-display text-[clamp(1.8rem,4vw,3rem)] leading-[1.1] text-white">
            {episode.title}
          </h1>
          <p className="mt-6 max-w-2xl text-[15px] leading-[1.7] text-white/75">
            {episode.description}
          </p>
          <div className="mt-6 text-[12px] uppercase tracking-[0.18em] text-white/45">
            {formatDuration(episode.durationMinutes)}
            {episode.guests && episode.guests.length > 0
              ? ` · with ${episode.guests.join(", ")}`
              : ""}
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
          {isPaid ? (
            <PaidEpisodeBlock />
          ) : (
            <PlayerBlock src={simplecastEmbedSrc(show.slug as ShowSlug, episode.slug)} />
          )}
        </div>
      </section>

      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Show notes
          </div>
          <p className="mt-6 max-w-2xl text-[14px] leading-[1.7] text-white/55">
            Full show notes and transcript will appear here once the episode is
            ingested. For now: see the episode description above.
          </p>
        </div>
      </section>
    </main>
  );
}

function PlayerBlock({ src }: { src: string }) {
  return (
    <div className="border border-white/15 bg-navy-800/40 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Listen
      </div>
      <p className="mt-3 text-[12px] text-white/55">
        Embedded Simplecast player loads here in production. Mock URL:{" "}
        <code className="text-white/70">{src}</code>
      </p>
      <div
        className="mt-4 flex h-[120px] items-center justify-center bg-navy-900/80 text-[12px] uppercase tracking-[0.22em] text-white/45"
        aria-label="Player placeholder"
      >
        Player placeholder
      </div>
    </div>
  );
}

function PaidEpisodeBlock() {
  return (
    <div className="border border-cyan/40 bg-navy-800/40 p-8">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Ark+ members only
      </div>
      <p className="mt-4 max-w-2xl text-[14px] leading-[1.6] text-white/75">
        This episode is part of the Inside Call Me Back private feed.
        Members listen in their podcast app, not here.
      </p>
      <Link
        to="/plus"
        className="mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Become an Ark+ member →
      </Link>
    </div>
  );
}
