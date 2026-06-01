import { Link } from "@tanstack/react-router";
import {
  episodeImage,
  formatEpisodeDateLong,
  type Episode,
} from "../data/episodes";
import type { Show } from "../data/shows";
import { listLatestEpisodes } from "../lib/simplecast";
import { useAsyncResource } from "../lib/useAsyncResource";
import { ContentError } from "./ContentError";

const DISPLAY_LIMIT = 3;

function PlayGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M2 1.2v7.6a.4.4 0 0 0 .61.34l6.1-3.8a.4.4 0 0 0 0-.68L2.61.86A.4.4 0 0 0 2 1.2Z" />
    </svg>
  );
}

function LatestEpisodeCard({
  show,
  episode,
}: {
  show: Show;
  episode: Episode;
}) {
  const image = episodeImage(episode, show);
  const episodeParams = {
    show: show.slug,
    episode: episode.slug,
  } as never;

  return (
    <article className="flex h-full flex-col overflow-hidden border border-rule bg-navy-800/40">
      <Link
        to="/podcasts/$show/$episode"
        params={episodeParams}
        className="group/image relative block aspect-video overflow-hidden bg-navy-900 p-2 sm:p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        {image ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            className="h-full w-full object-contain transition group-hover/image:opacity-95"
          />
        ) : (
          <div
            aria-hidden="true"
            className="h-full w-full bg-gradient-to-br from-navy-800/80 via-navy-700/40 to-navy-900/80"
          />
        )}
      </Link>

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <time
          dateTime={episode.publishedAt}
          className="text-body-sm"
        >
          {formatEpisodeDateLong(episode.publishedAt)}
        </time>
        <div className="mt-2 label text-fg-strong">
          {show.shortTitle}
        </div>
        <Link
          to="/podcasts/$show/$episode"
          params={episodeParams}
          className="mt-2 line-clamp-3 font-display text-[clamp(1.05rem,2vw,1.25rem)] leading-[1.2] text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          title={episode.title}
        >
          {episode.title}
        </Link>
        <Link
          to="/podcasts/$show/$episode"
          params={episodeParams}
          className="button-text mt-auto inline-flex items-center gap-2.5 pt-6 font-semibold text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan text-navy">
            <PlayGlyph />
          </span>
          Play episode
        </Link>
      </div>
    </article>
  );
}

function SectionHeading() {
  return (
    <h2 className="display-upright text-[clamp(1.5rem,3vw,2.25rem)] leading-none text-fg-strong">
      Latest episodes
    </h2>
  );
}

function NewRowBadge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -left-6 top-0 z-10 flex h-14 w-14 -translate-y-1/2 -rotate-12 items-center justify-center rounded-full border-[3px] border-cyan bg-cyan button-text font-display font-black tracking-cta text-navy shadow-[0_4px_14px_rgb(62_181_249_/_0.35)] sm:-left-8 sm:h-16 sm:w-16 "
    >
      New
    </span>
  );
}

export function LatestEpisodes() {
  const { status, data: episodes, retry } = useAsyncResource(
    () => listLatestEpisodes(DISPLAY_LIMIT),
    [],
  );

  if (status === "loading") {
    return (
      <section>
        <div className="page-section">
          <SectionHeading />
          <p className="mt-8 text-body-sm">Loading episodes…</p>
        </div>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section>
        <div className="page-section">
          <SectionHeading />
          <div className="mt-8">
            <ContentError
              message="We couldn't load the latest episodes. Refresh to try again."
              onRetry={retry}
            />
          </div>
        </div>
      </section>
    );
  }

  if (!episodes || episodes.length === 0) return null;

  return (
    <section>
      <div className="page-section">
        <SectionHeading />

        <div className="relative mt-10">
          <NewRowBadge />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {episodes.map(({ show, ...episode }) => (
              <LatestEpisodeCard
                key={`${show.slug}-${episode.slug}`}
                show={show}
                episode={episode}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
