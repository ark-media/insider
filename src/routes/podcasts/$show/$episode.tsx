import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  episodeImage,
  formatEpisodeDate,
  type Episode,
} from "../../../data/episodes";
import {
  getShow,
  showAtmosphere,
  type Show,
  type ShowSlug,
} from "../../../data/shows";
import { fetchEpisodeNotes, getEpisode } from "../../../lib/podcasts";
import { renderShowNotes } from "../../../lib/show-notes-renderer";
import { isArkPlusMember, useSubscriberAuth } from "../../../lib/subscriberAuth";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { EpisodeMeta } from "../../../components/EpisodeMeta";
import { ShowCover } from "../../../components/ShowCover";
import { ListenLinks } from "../../../components/ListenLinks";
import { ArkPlusMark } from "../../../components/ArkPlusMark";
import { AudioPlayer } from "../../../components/AudioPlayer";

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
    void fetchEpisodeNotes(show.slug as ShowSlug, episodeId).then((notes) => {
      if (!live || !notes) return;
      setEnriched(notes);
    });
    return () => {
      live = false;
    };
  }, [show.slug, episodeId]);

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
      <section className={`section-hero relative ${showAtmosphere(show.slug)}`}>
        <div className="page-gutter pt-8 pb-14 sm:pt-12">
          <EpisodeBreadcrumbs
            className="rise rise-1"
            show={show}
            trailing={formatEpisodeDate(episode.publishedAt)}
          />
          <div className="mt-8 grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-12">
            <div className="lg:col-span-8">
              {/* The Simplecast embed used to be the album header — it rendered
                  the episode art and title itself, so this <h1> was sr-only to
                  avoid saying the same thing twice. Our own player renders
                  controls only, so the title has to be visible again. */}
              <h1 className="max-w-3xl font-display text-[clamp(1.6rem,3.2vw,2.35rem)] leading-[1.15] text-fg-strong">
                {episode.title}
              </h1>
              <div className="episode-meta mt-3">
                <EpisodeMeta episode={episode} />
              </div>
              <div className="rise rise-2 mt-6">
                {isPaid ? (
                  <PaidEpisodeBlock episode={episode} show={show} />
                ) : (
                  <PlayerBlock episode={episode} show={show} />
                )}
              </div>

              {description ? (
                <p className="rise rise-3 mt-6 max-w-2xl text-body-lg">
                  {description}
                </p>
              ) : null}

              <h2 className="mt-14 label text-cyan">
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
            // Capped: inside the aside card the cover is a label for the show,
            // and filling the card made it the loudest thing on the page.
            sizes="180px"
            className="w-full max-w-[180px] border border-rule shadow-cover transition group-hover:opacity-95"
          />
        </Link>
        <div className="mt-5 label text-fg-muted">
          From the show
        </div>
        <Link
          to={show.route}
          className="mt-2 block text-h3 transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {show.title}
        </Link>
        <p className="mt-3 text-body-sm">
          {show.tagline}
        </p>
        <div className="mt-5 border-t border-rule pt-5 text-body-sm">
          <span className="font-semibold uppercase tracking-[0.18em] text-fg-faint">
            New episodes
          </span>
          <div className="mt-1.5 text-fg">{show.cadence}</div>
        </div>
      </div>

      {show.listen.length > 0 ? (
        <div className="mt-8">
          <h2 className="label text-cyan">
            Subscribe
          </h2>
          <ListenLinks listen={show.listen} className="mt-4" />
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
  "mt-6 max-w-2xl text-body-lg",
  "[&_p]:mt-4 [&_p:first-child]:mt-0",
  // Bulleted lists (e.g. Call Me Back's "More Ark Media" link directory) drop
  // their markers entirely and read as a clean line-per-item stack, rather than
  // a bulleted list. Ordered lists (e.g. "Chapters") keep their numbers.
  "[&_ul]:mt-5 [&_ul]:list-none [&_ul]:space-y-1.5 [&_ul]:pl-0",
  "[&_ol]:mt-5 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol>li]:mt-1.5",
  "[&_h2]:mt-9 [&_h2]:font-display [&_h2]:text-[19px] [&_h2]:text-fg-strong",
  "[&_h3]:mt-7 [&_h3]:font-display [&_h3]:text-[16px] [&_h3]:text-fg-strong",
  "[&_blockquote]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-cyan/40 [&_blockquote]:pl-4 [&_blockquote]:text-fg-muted",
  "[&_strong]:text-fg-strong [&_b]:text-fg-strong",
].join(" ");

function ShowNotes({ html }: { html: string | undefined }) {
  if (!html || !html.trim()) {
    return (
      <p className="mt-6 max-w-2xl text-body-sm">
        Show notes for this episode aren't published yet. The summary above is
        the full description for now.
      </p>
    );
  }
  // Trust boundary: `html` is pre-sanitized by sanitizeShowNotes on the server.
  return <div className={SHOW_NOTES_CLASS}>{renderShowNotes(html)}</div>;
}

function PlayerBlock({ episode, show }: { episode: Episode; show: Show }) {
  if (!episode.audioUrl) {
    return (
      <div className="border border-rule bg-navy-800/40 p-6">
        <div className="label text-cyan">
          Listen
        </div>
        <div className="mt-3 text-h3 text-fg-strong">{episode.title}</div>
        <p className="mt-3 text-body-sm">
          This episode isn't available in our player yet. Listen through your
          podcast app of choice.
        </p>
      </div>
    );
  }
  return (
    <AudioPlayer
      src={episode.audioUrl}
      title={episode.title}
      artworkUrl={episodeImage(episode, show)}
      fallbackDurationMinutes={episode.durationMinutes}
    />
  );
}

function PaidEpisodeBlock({
  episode,
  show,
}: {
  episode: Episode;
  show: Show;
}) {
  const { state } = useSubscriberAuth();
  // Gate on the paid tier, not just a signed-in session: a free user is still
  // `kind: "member"`, and a Beehiiv audio URL carries no auth of its own, so
  // this check is the only app-level gate on paid audio.
  if (isArkPlusMember(state)) {
    return <PlayerBlock episode={episode} show={show} />;
  }

  return (
    <div className="border border-cyan/40 bg-navy-800/40 p-8">
      <div className="flex items-center gap-4">
        <ArkPlusMark className="h-12 w-12" />
        <div className="label text-cyan">
          Ark+ members only
        </div>
      </div>
      {/* The player carries the episode title on unlocked episodes; when it's
          swapped out for this card, the card has to name the episode itself. */}
      <div className="mt-4 max-w-2xl text-h3 text-fg-strong">{episode.title}</div>
      <p className="mt-4 max-w-2xl text-body-sm text-fg">
        This episode is exclusively available to Ark+ members. Join Ark+ to listen.
      </p>
      <Link
        to="/plus"
        className="mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Subscribe →
      </Link>
    </div>
  );
}

function BackToShow({ show }: { show: Show }) {
  return (
    <section>
      <div className="page-gutter py-8">
        <Link
          to={show.route}
          className="group inline-flex items-center gap-3 label text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
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
      <section className={`section-hero relative ${showAtmosphere(show.slug)}`}>
        <div className="page-gutter pt-8 pb-14 sm:pt-12">
          <EpisodeBreadcrumbs show={show} />
          {/* Mirrors the loaded page's player-first shape so it doesn't reflow
              when the episode arrives. */}
          <div className="mt-8 grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-12">
            <div className="lg:col-span-8">
              <div className="h-[200px] w-full animate-pulse border border-rule bg-navy-800/40" />
              <div className="mt-14 label text-cyan">
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
      <section className="section-hero relative">
        <div className="page-gutter pt-8 pb-8 sm:pt-12">
          <EpisodeBreadcrumbs show={show} trailing="Episode not found" />
          <h1 className="mt-8 max-w-3xl font-display text-[clamp(1.8rem,4vw,3rem)] leading-[1.1] text-fg-strong">
            We couldn't find that episode.
          </h1>
          <p className="mt-6 max-w-2xl text-body-lg">
            The link may have changed, or the episode hasn't been published
            yet. Head back to the show for the full archive.
          </p>
          <Link
            to={show.route}
            className="mt-10 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <span aria-hidden="true">←</span>
            Back to {show.title}
          </Link>
        </div>
      </section>
    </main>
  );
}
