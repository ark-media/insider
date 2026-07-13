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
    // Horizontal row on phones (square thumb left, copy right), stacking into the
    // three-up card only once the grid does at `md`. Episode art is square, so the
    // media box is square too — it used to be `aspect-video` with `object-contain`,
    // which letterboxed the art and left 44% of every box as dead navy.
    <article className="flex h-full overflow-hidden border border-rule bg-navy-800/40 md:flex-col">
      <Link
        to="/podcasts/$show/$episode"
        params={episodeParams}
        className="group/image relative block size-28 shrink-0 overflow-hidden bg-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:size-32 md:aspect-square md:h-auto md:w-full"
      >
        {image ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition group-hover/image:opacity-95"
          />
        ) : (
          <div
            aria-hidden="true"
            className="h-full w-full bg-gradient-to-br from-navy-800/80 via-navy-700/40 to-navy-900/80"
          />
        )}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col p-4 md:p-6">
        <time
          dateTime={episode.publishedAt}
          className="text-body-sm"
        >
          {formatEpisodeDateLong(episode.publishedAt)}
        </time>
        <div className="mt-1 label text-fg-strong md:mt-2">
          {show.shortTitle}
        </div>
        <Link
          to="/podcasts/$show/$episode"
          params={episodeParams}
          className="mt-1.5 line-clamp-2 font-display text-[16px] leading-[1.2] text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan md:mt-2 md:line-clamp-3 md:text-[clamp(1.05rem,2vw,1.25rem)]"
          title={episode.title}
        >
          {episode.title}
        </Link>
        <Link
          to="/podcasts/$show/$episode"
          params={episodeParams}
          className="button-text mt-auto inline-flex min-h-11 w-fit items-center gap-2.5 pt-3 font-semibold text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan md:pt-6"
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
      // `-left-6` exactly cancelled the 24px page gutter, so the badge sat flush
      // at x=0 on a 390px phone and was sliced by the viewport edge at 320px.
      // `-left-3` keeps it hanging off the grid without ever leaving the page.
      className="pointer-events-none absolute -left-3 top-0 z-10 flex h-14 w-14 -translate-y-1/2 -rotate-12 items-center justify-center rounded-full border-[3px] border-cyan bg-cyan button-text font-display font-black tracking-cta text-navy shadow-[0_4px_14px_rgb(62_181_249_/_0.35)] sm:-left-8 sm:h-16 sm:w-16"
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
