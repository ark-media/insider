import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  formatDuration,
  formatEpisodeDate,
  type Episode,
} from "../../../data/episodes";
import { getShow, type ShowSlug } from "../../../data/shows";
import {
  fetchEpisodeNotes,
  getEpisode,
  simplecastEpisodeSrc,
} from "../../../lib/simplecast";
import { renderShowNotes } from "../../../lib/show-notes-renderer";
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
  const [enriched, setEnriched] = useState<
    { showNotesHtml: string; description: string } | null
  >(null);

  useEffect(() => {
    let live = true;
    void getEpisode(show.slug as ShowSlug, episodeSlug).then(
      (r) => live && setEpisode(r),
    );
    return () => {
      live = false;
    };
  }, [show.slug, episodeSlug]);

  const episodeId =
    typeof episode === "object" && episode ? episode.id : undefined;
  useEffect(() => {
    if (!episodeId) return;
    let live = true;
    void fetchEpisodeNotes(episodeId).then((notes) => {
      if (!live || !notes) return;
      setEnriched(notes);
    });
    return () => {
      live = false;
    };
  }, [episodeId]);

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
            {enriched?.description || episode.description}
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
            <PlayerBlock episode={episode} />
          )}
        </div>
      </section>

      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Show notes
          </div>
          <ShowNotes html={enriched?.showNotesHtml || episode.showNotesHtml} />
        </div>
      </section>
    </main>
  );
}

function ShowNotes({ html }: { html: string | undefined }) {
  if (!html || !html.trim()) {
    return (
      <p className="mt-6 max-w-2xl text-[14px] leading-[1.7] text-white/55">
        Full show notes and transcript will appear here once the episode is
        ingested. For now: see the episode description above.
      </p>
    );
  }
  // Trust boundary: `html` is pre-sanitized by sanitizeShowNotes on the server.
  return (
    <div className="mt-6 max-w-2xl text-[14px] leading-[1.7] text-white/75 [&_p]:mt-4 [&_p:first-child]:mt-0 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mt-1 [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-[18px] [&_h2]:text-white [&_h3]:mt-6 [&_h3]:font-display [&_h3]:text-[15px] [&_h3]:text-white [&_blockquote]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-cyan/40 [&_blockquote]:pl-4 [&_blockquote]:text-white/65 [&_strong]:text-white [&_b]:text-white">
      {renderShowNotes(html)}
    </div>
  );
}

function PlayerBlock({ episode }: { episode: Episode }) {
  if (!episode.id) {
    return (
      <div className="border border-white/15 bg-navy-800/40 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Listen
        </div>
        <p className="mt-3 text-[12px] text-white/55">
          This episode isn't available in our embedded player yet. Listen
          through your podcast app of choice.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-white/15 bg-navy-800/40">
      <iframe
        title={`${episode.title} — player`}
        src={simplecastEpisodeSrc(episode.id)}
        height={200}
        width="100%"
        scrolling="no"
        allow="clipboard-write"
        loading="lazy"
        className="block w-full border-0"
      />
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
