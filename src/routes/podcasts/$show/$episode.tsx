import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  formatDuration,
  formatEpisodeDate,
  type Episode,
} from "../../../data/episodes";
import {
  LISTEN_PLATFORM_LABEL,
  getShow,
  showAtmosphere,
  type Show,
  type ShowSlug,
} from "../../../data/shows";
import {
  fetchEpisodeNotes,
  getEpisode,
  simplecastEpisodeSrc,
} from "../../../lib/simplecast";
import { renderShowNotes } from "../../../lib/show-notes-renderer";
import { useSubscriberAuth } from "../../../lib/subscriberAuth";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { ShowCover } from "../../../components/ShowCover";

export const Route = createFileRoute("/podcasts/$show/$episode")({
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
  const description = enriched?.description || episode.description;

  return (
    <main className="relative">
      <section className={`relative ${showAtmosphere(show.slug)}`}>
        <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-14 sm:px-10 sm:pt-16">
          <EpisodeBreadcrumbs
            className="rise rise-1"
            show={show}
            trailing={formatEpisodeDate(episode.publishedAt)}
          />
          <h1 className="rise rise-2 mt-8 max-w-4xl font-display text-[clamp(2rem,4.5vw,3.4rem)] leading-[1.05] text-fg-strong">
            {episode.title}
          </h1>
          {description ? (
            <p className="rise rise-3 mt-6 max-w-2xl text-[15px] leading-[1.7] text-fg">
              {description}
            </p>
          ) : null}
          <div className="rise rise-4 mt-7 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
            <span>{formatDuration(episode.durationMinutes)}</span>
            {episode.guests && episode.guests.length > 0 ? (
              <>
                <span aria-hidden="true" className="text-fg-faint">
                  ·
                </span>
                <span>with {episode.guests.join(", ")}</span>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-14 sm:px-10 sm:py-16">
          <div className="grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-12">
            <div className="lg:col-span-8">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Listen
              </h2>
              <div className="mt-5">
                {isPaid ? (
                  <PaidEpisodeBlock episode={episode} />
                ) : (
                  <PlayerBlock episode={episode} />
                )}
              </div>

              <h2 className="mt-14 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Show notes
              </h2>
              <ShowNotes html={enriched?.showNotesHtml || episode.showNotesHtml} />
            </div>

            <aside className="lg:col-span-4">
              <EpisodeAside show={show} />
            </aside>
          </div>
        </div>
      </section>

      <BackToShow show={show} />
    </main>
  );
}

// The sidebar that fills the right column: the show's identity (cover + link),
// where to subscribe, and the cadence — built from the site's own structured
// data rather than the raw show-notes link dump.
function EpisodeAside({ show }: { show: Show }) {
  return (
    <div className="lg:sticky lg:top-24">
      <div className="border border-rule bg-navy-800/40 p-6">
        <Link
          to={show.route}
          className="group block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <ShowCover
            show={show}
            className="w-full border border-rule shadow-cover transition group-hover:opacity-95"
          />
        </Link>
        <div className="mt-5 text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
          From the show
        </div>
        <Link
          to={show.route}
          className="mt-2 block font-display text-[20px] leading-[1.15] text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {show.title}
        </Link>
        <p className="mt-3 text-[13px] leading-[1.6] text-fg-muted">
          {show.tagline}
        </p>
        <div className="mt-5 border-t border-rule pt-5 text-[12px] text-fg-muted">
          <span className="font-semibold uppercase tracking-[0.18em] text-fg-faint">
            New episodes
          </span>
          <div className="mt-1.5 text-fg">{show.cadence}</div>
        </div>
      </div>

      {show.listen.length > 0 ? (
        <div className="mt-8">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Subscribe
          </h2>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {show.listen.map((l) => (
              <a
                key={l.platform}
                href={l.url}
                target="_blank"
                rel="noreferrer noopener"
                className="border border-rule-strong px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-fg transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                {LISTEN_PLATFORM_LABEL[l.platform]}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EpisodeBreadcrumbs({
  show,
  trailing,
  className,
}: {
  show: Show;
  trailing?: string;
  className?: string;
}) {
  const items: Array<{ label: string; to?: string }> = [
    { label: "Home", to: "/" },
    { label: "Podcasts", to: "/podcasts" },
    { label: show.shortTitle, to: show.route },
  ];
  if (trailing) items.push({ label: trailing });
  return <Breadcrumbs className={className} items={items} />;
}

const SHOW_NOTES_CLASS = [
  "mt-6 max-w-2xl text-[15px] leading-[1.75] text-fg",
  "[&_p]:mt-4 [&_p:first-child]:mt-0",
  // Lists drop the default disc/decimal marker for a brand-cyan tick (see
  // BULLET_MARKER in show-notes-renderer) so link lists read as editorial.
  "[&_ul]:mt-5 [&_ul]:list-none [&_ul]:space-y-2.5 [&_ul]:pl-0",
  "[&_ul>li]:relative [&_ul>li]:pl-5",
  "[&_ul>li]:before:absolute [&_ul>li]:before:left-0 [&_ul>li]:before:top-[0.62em] [&_ul>li]:before:h-[2px] [&_ul>li]:before:w-[10px] [&_ul>li]:before:rounded-full [&_ul>li]:before:bg-cyan/70 [&_ul>li]:before:content-['']",
  "[&_ol]:mt-5 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol>li]:mt-1.5",
  "[&_h2]:mt-9 [&_h2]:font-display [&_h2]:text-[19px] [&_h2]:text-fg-strong",
  "[&_h3]:mt-7 [&_h3]:font-display [&_h3]:text-[16px] [&_h3]:text-fg-strong",
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

function PaidEpisodeBlock({ episode }: { episode: Episode }) {
  const { state } = useSubscriberAuth();
  const isMember = state.kind === "member";

  if (isMember) {
    return <PlayerBlock episode={episode} />;
  }

  return (
    <div className="border border-cyan/40 bg-navy-800/40 p-8">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Ark+ members only
      </div>
      <p className="mt-4 max-w-2xl text-[14px] leading-[1.6] text-fg">
        This episode is part of Inside Call Me Back. Join Ark+ to listen.
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
      <section className={`relative ${showAtmosphere(show.slug)}`}>
        <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-14 sm:px-10 sm:pt-16">
          <EpisodeBreadcrumbs show={show} />
          <div className="mt-6 h-3 w-40 animate-pulse rounded bg-fg-strong/8" />
          <div className="mt-4 max-w-4xl space-y-3">
            <div className="h-[clamp(2rem,4.5vw,3.4rem)] w-full max-w-3xl animate-pulse rounded bg-fg-strong/8" />
            <div className="h-[clamp(2rem,4.5vw,3.4rem)] w-2/3 animate-pulse rounded bg-fg-strong/8" />
          </div>
          <div className="mt-7 h-3 w-40 animate-pulse rounded bg-fg-strong/8" />
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-14 sm:px-10 sm:py-16">
          <div className="grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-12">
            <div className="lg:col-span-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Listen
              </div>
              <div className="mt-5 h-[200px] w-full animate-pulse border border-rule bg-navy-800/40" />
              <div className="mt-14 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Show notes
              </div>
              <div className="mt-6 max-w-2xl space-y-2.5">
                <div className="h-3 w-full animate-pulse rounded bg-fg-strong/8" />
                <div className="h-3 w-11/12 animate-pulse rounded bg-fg-strong/8" />
                <div className="h-3 w-10/12 animate-pulse rounded bg-fg-strong/8" />
                <div className="h-3 w-9/12 animate-pulse rounded bg-fg-strong/8" />
              </div>
            </div>
            <div className="lg:col-span-4">
              <div className="aspect-square w-full animate-pulse border border-rule bg-navy-800/40" />
            </div>
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
          <EpisodeBreadcrumbs show={show} trailing="Episode not found" />
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
