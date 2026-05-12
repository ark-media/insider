import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  formatDuration,
  formatEpisodeDate,
  type Episode,
} from "../../../data/episodes";
import { getShow, type Show, type ShowSlug } from "../../../data/shows";
import {
  fetchEpisodeNotes,
  getEpisode,
  simplecastEpisodeSrc,
} from "../../../lib/simplecast";
import { renderShowNotes } from "../../../lib/show-notes-renderer";
import { useSubscriberAuth } from "../../../lib/subscriberAuth";

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
    return <EpisodeSkeleton show={show} />;
  }

  if (!episode) {
    return <EpisodeNotFound show={show} />;
  }

  const isPaid = show.paid;

  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-12 sm:px-10 sm:pt-16">
          <Breadcrumb show={show} trailing={formatEpisodeDate(episode.publishedAt)} />
          <h1 className="mt-8 max-w-3xl font-display text-[clamp(1.8rem,4vw,3rem)] leading-[1.1] text-fg-strong">
            {episode.title}
          </h1>
          <p className="mt-6 max-w-2xl text-[15px] leading-[1.7] text-fg">
            {enriched?.description || episode.description}
          </p>
          <div className="mt-6 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
            {formatDuration(episode.durationMinutes)}
            {episode.guests && episode.guests.length > 0
              ? ` · with ${episode.guests.join(", ")}`
              : ""}
          </div>
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
          {isPaid ? <PaidEpisodeBlock /> : <PlayerBlock episode={episode} />}
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Show notes
          </div>
          <ShowNotes html={enriched?.showNotesHtml || episode.showNotesHtml} />
        </div>
      </section>

      <BackToShow show={show} />
    </main>
  );
}

function Breadcrumb({ show, trailing }: { show: Show; trailing?: string }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
      <Link
        to={show.route}
        className="transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        {show.shortTitle}
      </Link>
      {trailing ? <span className="text-fg-muted"> · {trailing}</span> : null}
    </div>
  );
}

const SHOW_NOTES_CLASS = [
  "mt-6 max-w-2xl text-[14px] leading-[1.7] text-fg",
  "[&_p]:mt-4 [&_p:first-child]:mt-0",
  "[&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-6",
  "[&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:mt-1",
  "[&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-[18px] [&_h2]:text-fg-strong",
  "[&_h3]:mt-6 [&_h3]:font-display [&_h3]:text-[15px] [&_h3]:text-fg-strong",
  "[&_blockquote]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-cyan/40 [&_blockquote]:pl-4 [&_blockquote]:text-fg-muted",
  "[&_strong]:text-fg-strong [&_b]:text-fg-strong",
].join(" ");

function ShowNotes({ html }: { html: string | undefined }) {
  if (!html || !html.trim()) {
    return (
      <p className="mt-6 max-w-2xl text-[14px] leading-[1.7] text-fg-muted">
        Show notes for this episode aren't published yet. The summary above is
        the full description for now.
      </p>
    );
  }
  // Trust boundary: `html` is pre-sanitized by sanitizeShowNotes on the server.
  return <div className={SHOW_NOTES_CLASS}>{renderShowNotes(html)}</div>;
}

function PlayerBlock({ episode }: { episode: Episode }) {
  if (!episode.id) {
    return (
      <div className="border border-rule bg-navy-800/40 p-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Listen
        </div>
        <p className="mt-3 text-[13px] leading-[1.6] text-fg-muted">
          This episode isn't available in our embedded player yet. Listen
          through your podcast app of choice.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-rule bg-navy-800/40">
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
  const { state } = useSubscriberAuth();
  const isMember = state.kind === "member";

  if (isMember) {
    return (
      <div className="border border-cyan/40 bg-navy-800/40 p-8">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          You're a member
        </div>
        <p className="mt-4 max-w-2xl text-[14px] leading-[1.6] text-fg">
          Inside Call Me Back episodes play in your private Ark+ feed, not on
          the site. Add the feed to your podcast app once and new episodes show
          up automatically.
        </p>
        <Link
          to="/account/podcast-feed"
          className="mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Set up the feed →
        </Link>
      </div>
    );
  }

  return (
    <div className="border border-cyan/40 bg-navy-800/40 p-8">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Ark+ members only
      </div>
      <p className="mt-4 max-w-2xl text-[14px] leading-[1.6] text-fg">
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

function BackToShow({ show }: { show: Show }) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
        <Link
          to={show.route}
          className="group inline-flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <span
            aria-hidden="true"
            className="inline-block transition-transform group-hover:-translate-x-1"
          >
            ←
          </span>
          All {show.shortTitle} episodes
        </Link>
      </div>
    </section>
  );
}

function EpisodeSkeleton({ show }: { show: Show }) {
  return (
    <main className="relative" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading episode</span>
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-12 sm:px-10 sm:pt-16">
          <Breadcrumb show={show} />
          <div className="mt-8 max-w-3xl space-y-3">
            <div className="h-[clamp(1.8rem,4vw,3rem)] w-full max-w-2xl animate-pulse rounded bg-white/8" />
            <div className="h-[clamp(1.8rem,4vw,3rem)] w-3/4 animate-pulse rounded bg-white/8" />
          </div>
          <div className="mt-6 max-w-2xl space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-white/6" />
            <div className="h-3 w-full animate-pulse rounded bg-white/6" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-white/6" />
          </div>
          <div className="mt-6 h-3 w-40 animate-pulse rounded bg-white/6" />
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
          <div className="h-[200px] w-full animate-pulse border border-rule bg-navy-800/40" />
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Show notes
          </div>
          <div className="mt-6 max-w-2xl space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-white/6" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-white/6" />
            <div className="h-3 w-10/12 animate-pulse rounded bg-white/6" />
            <div className="h-3 w-9/12 animate-pulse rounded bg-white/6" />
          </div>
        </div>
      </section>
    </main>
  );
}

function EpisodeNotFound({ show }: { show: Show }) {
  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-12 sm:px-10 sm:pt-16">
          <Breadcrumb show={show} trailing="Episode not found" />
          <h1 className="mt-8 max-w-3xl font-display text-[clamp(1.8rem,4vw,3rem)] leading-[1.1] text-fg-strong">
            We couldn't find that episode.
          </h1>
          <p className="mt-6 max-w-2xl text-[15px] leading-[1.7] text-fg">
            The link may have changed, or the episode hasn't been published
            yet. Head back to the show for the full archive.
          </p>
          <Link
            to={show.route}
            className="mt-10 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <span aria-hidden="true">←</span>
            Back to {show.title}
          </Link>
        </div>
      </section>
    </main>
  );
}
