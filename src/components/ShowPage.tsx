import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LISTEN_PLATFORM_LABEL,
  getShow,
  showAtmosphere,
  type ListenLink,
  type Show,
  type ShowSlug,
} from "../data/shows";
import {
  formatDuration,
  formatEpisodeDate,
  type Episode,
} from "../data/episodes";
import { hostsForShow } from "../data/hosts";
import { listEpisodes, simplecastEpisodeSrc } from "../lib/simplecast";
import { PageShell, PlaceholderSection } from "./PageShell";
import { Breadcrumbs } from "./Breadcrumbs";
import { HostArtwork } from "./HostArtwork";
import { ShowCover } from "./ShowCover";
import { useSubscriberAuth } from "../lib/subscriberAuth";

export function ShowPage({ slug }: { slug: ShowSlug }) {
  const show = getShow(slug);
  if (!show) {
    return (
      <PageShell
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Podcasts", to: "/podcasts" },
              { label: "Not found" },
            ]}
          />
        }
        title="Show not found"
        lede="We couldn't find that show."
      >
        <PlaceholderSection
          title="Looking for a show?"
          body="Browse all of our podcasts from the hub."
        />
      </PageShell>
    );
  }

  return show.paid ? <PaidShowPage show={show} /> : <PublicShowPage show={show} />;
}

function PublicShowPage({ show }: { show: Show }) {
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);

  useEffect(() => {
    let live = true;
    void listEpisodes(show.slug).then((r) => live && setEpisodes(r));
    return () => {
      live = false;
    };
  }, [show.slug]);

  return (
    <main className="relative">
      <ShowHero show={show} />

      {showHasPaidExtension(show.slug) ? <ShowUpsell show={show} /> : null}

      <EpisodeBrowser show={show} episodes={episodes} />

      <HostsSection show={show} />

      <RelatedShows currentSlug={show.slug} relatedSlugs={show.related} />
    </main>
  );
}

function PaidShowPage({ show }: { show: Show }) {
  const { state } = useSubscriberAuth();
  const isMember = state.kind === "member";
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);

  // Drop episodes loaded in a prior member session once the viewer is no
  // longer a member, so a stale list can't flash if they sign back in.
  if (!isMember && episodes !== null) {
    setEpisodes(null);
  }

  useEffect(() => {
    if (!isMember) return;
    let live = true;
    void listEpisodes(show.slug).then((r) => live && setEpisodes(r));
    return () => {
      live = false;
    };
  }, [show.slug, isMember]);

  return (
    <main className="relative">
      <ShowHero show={show} />

      {isMember ? (
        <EpisodeBrowser
          show={show}
          episodes={episodes}
          headerLink={
            <Link
              to="/account/podcast-feed"
              className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-muted transition hover:text-cyan"
            >
              Set up private feed →
            </Link>
          }
        />
      ) : (
        <PaidShowJoinCta show={show} />
      )}
      <HostsSection show={show} />
      <RelatedShows currentSlug={show.slug} relatedSlugs={show.related} />
    </main>
  );
}

function PaidShowJoinCta({ show }: { show: Show }) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Ark+ members only
            </div>
            <h2 className="mt-6 max-w-2xl font-display text-[clamp(1.5rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
              Join Ark+ to listen to {show.title}.
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-[1.7] text-fg">
              Members get extended interviews, ad-free episodes, members-only
              Q&amp;As, the Ark+ newsletter, and the community — one membership,
              one bill.
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="border border-rule bg-navy-800/40 p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Get Ark+
              </div>
              <p className="mt-4 text-[14px] leading-[1.6] text-fg">
                Full access to {show.title} plus everything else in Ark+.
              </p>
              <Link
                to="/plus"
                className="mt-8 inline-flex w-full items-center justify-between bg-cyan px-5 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-fg-strong hover:text-navy-900"
              >
                See Ark+ membership
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ShowHero({ show }: { show: Show }) {
  return (
    <section className={`relative ${showAtmosphere(show.slug)}`}>
      <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-12 sm:px-10 sm:pt-16">
        <Breadcrumbs
          className="rise rise-1 mb-6"
          items={[
            { label: "Home", to: "/" },
            { label: "Podcasts", to: "/podcasts" },
            { label: show.shortTitle },
          ]}
        />
        <p className="inside-tab rise rise-1 text-[12px]">
          {show.shortTitle}
        </p>
        <div className="mt-10 grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h1 className="rise rise-2 max-w-3xl text-fg-strong">
              <span className="display-upright block text-[clamp(2.4rem,6vw,4.6rem)] leading-[1.02]">
                {show.title}
              </span>
            </h1>
            {show.hosts.length > 0 ? (
              <p className="rise rise-3 mt-6 text-[14px] uppercase tracking-[0.22em] text-fg-muted">
                with {show.hosts.join(" · ")}
              </p>
            ) : null}
            <p className="rise rise-4 mt-6 max-w-xl text-[15px] leading-[1.65] text-fg">
              {show.tagline}
            </p>
            {show.listen.length > 0 ? (
              <ListenRow listen={show.listen} className="mt-10" />
            ) : null}
          </div>
          <div className="lg:col-span-5">
            <ShowArtwork show={show} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ShowUpsell({ show: _show }: { show: Show }) {
  return (
    <section className="border-t border-rule bg-navy-800/40">
      <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
        <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Want more?
            </div>
            <p className="mt-3 max-w-2xl text-[15px] leading-[1.6] text-fg">
              <span className="font-display text-[18px]">Inside Call Me Back</span>{" "}
              delivers extended interviews, ad-free episodes, and
              members-only Q&amp;As — included with Ark+.
            </p>
          </div>
          <div className="lg:col-span-4 lg:text-right">
            <Link
              to="/plus"
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Become an Ark+ member →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function ShowArtwork({ show }: { show: Show }) {
  return (
    <ShowCover
      show={show}
      priority
      className="w-full max-w-md border border-rule shadow-cover"
    />
  );
}

function ListenRow({
  listen,
  className,
}: {
  listen: ListenLink[];
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-5 gap-y-3 text-[13px] text-fg-muted ${
        className ?? ""
      }`}
    >
      {listen.map((l) => (
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
  );
}

// How many rows to reveal per "Show more" press (search results).
const ARCHIVE_PAGE_SIZE = 8;

// Owns the show's episode-listening experience: an in-place player plus the
// grid and archive that feed it. Any episode is playable without leaving the
// page — clicking Play swaps the player's source to that episode and scrolls
// it into view (the Crooked-style "listen here, browse here" model). The
// player defaults to the latest episode; the grid and archive skip whatever
// the player is showing only by skipping the latest, so the layout stays
// stable as the selection changes.
function EpisodeBrowser({
  show,
  episodes,
  headerLink,
}: {
  show: Show;
  episodes: Episode[] | null;
  headerLink?: ReactNode;
}) {
  // Reset the player selection when navigating between shows so an episode
  // chosen on one show can't linger in the player on the next.
  const [selected, setSelected] = useState<{ slug: ShowSlug; id: string | null }>(
    { slug: show.slug, id: null },
  );
  if (selected.slug !== show.slug) {
    setSelected({ slug: show.slug, id: null });
  }
  const [query, setQuery] = useState("");
  const playerRef = useRef<HTMLDivElement>(null);

  const featuredEpisode = episodes?.find((ep) => Boolean(ep.id)) ?? null;
  const remaining = (episodes ?? []).filter(
    (ep) => ep.slug !== featuredEpisode?.slug,
  );
  const latest = remaining.slice(0, 3);
  const archive = remaining.slice(3);

  const selectedEpisode =
    (selected.id ? episodes?.find((ep) => ep.id === selected.id) : null) ??
    featuredEpisode;
  const activeId = selectedEpisode?.id ?? null;
  const isLatest = selectedEpisode?.slug === featuredEpisode?.slug;

  function play(ep: Episode) {
    if (!ep.id) return;
    setSelected({ slug: show.slug, id: ep.id });
    playerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = searching
    ? remaining.filter(
        (ep) =>
          ep.title.toLowerCase().includes(q) ||
          (ep.guests?.some((g) => g.toLowerCase().includes(q)) ?? false),
      )
    : [];

  return (
    <>
      <div ref={playerRef}>
        {selectedEpisode ? (
          <ShowPlayer episode={selectedEpisode} isLatest={isLatest} />
        ) : null}
      </div>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              {featuredEpisode ? "More episodes" : "Latest episodes"}
            </div>
            <div className="flex items-center gap-5">
              {episodes && episodes.length > 4 ? (
                <EpisodeSearch value={query} onChange={setQuery} />
              ) : null}
              {headerLink}
            </div>
          </div>

          {episodes === null ? (
            <p className="mt-8 text-[14px] text-fg-muted">Loading episodes…</p>
          ) : remaining.length === 0 ? (
            <p className="mt-8 text-[14px] text-fg-muted">
              {featuredEpisode
                ? "That's the only episode so far — more coming soon."
                : "No episodes yet — check back soon."}
            </p>
          ) : searching ? (
            <EpisodeList
              show={show}
              episodes={matches}
              onPlay={play}
              activeId={activeId}
              label={`${matches.length} ${
                matches.length === 1 ? "result" : "results"
              } for “${query.trim()}”`}
              emptyLabel={`No episodes match “${query.trim()}”.`}
            />
          ) : (
            <>
              <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
                {latest.map((ep) => (
                  <EpisodeCard
                    key={ep.slug}
                    show={show}
                    episode={ep}
                    onPlay={() => play(ep)}
                    isActive={Boolean(ep.id) && ep.id === activeId}
                  />
                ))}
              </div>
              {archive.length > 0 ? (
                <EpisodeList
                  show={show}
                  episodes={archive}
                  onPlay={play}
                  activeId={activeId}
                  label="All episodes"
                  maxVisibleRows={4}
                />
              ) : null}
            </>
          )}
        </div>
      </section>
    </>
  );
}

function EpisodeSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center">
      <span className="sr-only">Search episodes</span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search episodes"
        className="w-full min-w-[12rem] border border-rule bg-navy-800/40 px-3 py-1.5 text-[13px] text-fg placeholder:text-fg-muted transition focus:border-cyan focus-visible:outline-none sm:w-56"
      />
    </label>
  );
}

// A flat episode list used for both the back catalog and search results.
// Search results paginate via "Show more". The back catalog passes
// maxVisibleRows to become a fixed-height scroll box sized to exactly that
// many rows instead.
function EpisodeList({
  show,
  episodes,
  onPlay,
  activeId,
  label,
  emptyLabel,
  maxVisibleRows,
}: {
  show: Show;
  episodes: Episode[];
  onPlay: (ep: Episode) => void;
  activeId: string | null;
  label: string;
  emptyLabel?: string;
  maxVisibleRows?: number;
}) {
  const [visible, setVisible] = useState(ARCHIVE_PAGE_SIZE);

  // When capped, the list scrolls inside a box sized to maxVisibleRows. The
  // height is measured from the rendered rows so it tracks whatever the real
  // row height is rather than assuming a fixed pixel value. We track the raw
  // measurement and derive the applied height — when the list shrinks below
  // the cap, `scrollable` flips false and we render with no maxHeight without
  // needing a state reset in the effect.
  const scrollable =
    maxVisibleRows != null && episodes.length > maxVisibleRows;
  const listRef = useRef<HTMLUListElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number>();
  useEffect(() => {
    if (!scrollable) return;
    const ul = listRef.current;
    if (!ul) return;
    const rows = Array.from(ul.children).slice(
      0,
      maxVisibleRows,
    ) as HTMLElement[];
    // Add the ul's own top/bottom border so the scroll box doesn't clip its
    // bottom rule. Derived from computed style rather than hardcoded so a
    // theme change to border thickness doesn't silently break the math.
    const cs = window.getComputedStyle(ul);
    const borderY =
      (parseFloat(cs.borderTopWidth) || 0) +
      (parseFloat(cs.borderBottomWidth) || 0);
    setMeasuredHeight(
      rows.reduce((h, row) => h + row.offsetHeight, 0) + borderY,
    );
  }, [scrollable, maxVisibleRows, episodes]);
  const maxHeight = scrollable ? measuredHeight : undefined;

  const shown =
    maxVisibleRows != null ? episodes : episodes.slice(0, visible);

  return (
    <div id="all-episodes" className="mt-16">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
        {label}
      </div>
      {episodes.length === 0 ? (
        <p className="mt-6 text-[14px] text-fg-muted">
          {emptyLabel ?? "No episodes."}
        </p>
      ) : (
        <>
          <ul
            ref={listRef}
            style={maxHeight != null ? { maxHeight } : undefined}
            className={`mt-6 divide-y divide-rule border-y border-rule${
              scrollable ? " overflow-y-auto" : ""
            }`}
          >
            {shown.map((ep) => (
              <EpisodeRow
                key={ep.slug}
                show={show}
                episode={ep}
                onPlay={onPlay}
                isActive={Boolean(ep.id) && ep.id === activeId}
              />
            ))}
          </ul>
          {maxVisibleRows == null && episodes.length > visible ? (
            <button
              type="button"
              onClick={() => setVisible((v) => v + ARCHIVE_PAGE_SIZE)}
              className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Show more episodes
              <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function EpisodeRow({
  show,
  episode,
  onPlay,
  isActive,
}: {
  show: Show;
  episode: Episode;
  onPlay: (ep: Episode) => void;
  isActive: boolean;
}) {
  return (
    <li
      className={`group flex items-center gap-4 py-4 transition ${
        isActive ? "text-cyan" : "text-fg"
      }`}
    >
      {episode.id ? (
        <button
          type="button"
          onClick={() => onPlay(episode)}
          aria-label={`Play ${episode.title}`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-rule-strong text-fg-muted transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {isActive ? <EqualizerGlyph /> : <PlayGlyph />}
        </button>
      ) : (
        <span className="h-8 w-8 shrink-0" aria-hidden="true" />
      )}
      <Link
        to="/podcasts/$show/$episode"
        params={{ show: show.slug, episode: episode.slug } as never}
        className="min-w-0 flex-1 transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <span
          className="line-clamp-1 font-display text-[14px] tracking-[-0.005em]"
          title={episode.title}
        >
          {episode.title}
        </span>
        {episode.guests && episode.guests.length > 0 ? (
          <span className="mt-0.5 block truncate text-[11px] text-fg-muted">
            With {episode.guests.join(", ")}
          </span>
        ) : null}
      </Link>
      <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-fg-muted">
        {formatEpisodeDate(episode.publishedAt)} ·{" "}
        {formatDuration(episode.durationMinutes)}
      </span>
    </li>
  );
}

function EpisodeCard({
  show,
  episode,
  onPlay,
  isActive,
}: {
  show: Show;
  episode: Episode;
  onPlay: () => void;
  isActive: boolean;
}) {
  return (
    <div
      className={`group flex h-full flex-col border bg-navy-800/40 p-6 transition ${
        isActive ? "border-cyan" : "border-rule"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          {formatEpisodeDate(episode.publishedAt)} ·{" "}
          {formatDuration(episode.durationMinutes)}
        </div>
        {isActive ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan" aria-hidden="true" />
            Now playing
          </span>
        ) : null}
      </div>
      <Link
        to="/podcasts/$show/$episode"
        params={{ show: show.slug, episode: episode.slug } as never}
        className="mt-4 line-clamp-2 font-display text-[18px] leading-[1.2] text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        title={episode.title}
      >
        {episode.title}
      </Link>
      {episode.guests && episode.guests.length > 0 ? (
        <p className="mt-2 text-[12px] uppercase tracking-[0.14em] text-fg-muted">
          With {episode.guests.join(", ")}
        </p>
      ) : null}
      <p className="mt-3 line-clamp-3 text-[13px] leading-[1.6] text-fg-muted">
        {episode.description}
      </p>
      <div className="mt-auto flex items-center gap-4 pt-6">
        {episode.id ? (
          <button
            type="button"
            onClick={onPlay}
            className="inline-flex items-center gap-2 border border-cyan px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan transition hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <PlayGlyph />
            Play
          </button>
        ) : null}
        <Link
          to="/podcasts/$show/$episode"
          params={{ show: show.slug, episode: episode.slug } as never}
          className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          View episode →
        </Link>
      </div>
    </div>
  );
}

function ShowPlayer({
  episode,
  isLatest,
}: {
  episode: Episode;
  isLatest: boolean;
}) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              {isLatest ? "Latest episode" : "Now playing"}
            </div>
            {isLatest ? (
              <span className="border border-cyan px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan">
                New
              </span>
            ) : null}
          </div>
          <Link
            to="/podcasts/$show/$episode"
            params={{ show: episode.showSlug, episode: episode.slug } as never}
            className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            View episode →
          </Link>
        </div>
        <h2
          className="mt-4 max-w-3xl font-display text-[clamp(1.4rem,2.6vw,2rem)] leading-[1.15] text-fg-strong"
          title={episode.title}
        >
          {episode.title}
        </h2>
        <div className="mt-3 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
          {formatEpisodeDate(episode.publishedAt)} ·{" "}
          {formatDuration(episode.durationMinutes)}
        </div>
        <div className="mt-8 border border-rule bg-navy-800/40">
          <iframe
            key={episode.id}
            title={`${episode.title} — player`}
            src={simplecastEpisodeSrc(episode.id!)}
            height={200}
            width="100%"
            scrolling="no"
            allow="clipboard-write"
            loading="lazy"
            className="block w-full border-0"
          />
        </div>
      </div>
    </section>
  );
}

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

function EqualizerGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="1" y="4" width="1.6" height="5" rx="0.5" />
      <rect x="4.2" y="1.5" width="1.6" height="7.5" rx="0.5" />
      <rect x="7.4" y="3" width="1.6" height="6" rx="0.5" />
    </svg>
  );
}

function HostsSection({ show }: { show: Show }) {
  const hosts = hostsForShow(show.slug);
  if (hosts.length === 0) return null;
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Hosts
        </div>
        <div className="mt-10 grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {hosts.map((h, i) => (
            <Link
              key={h.slug}
              to="/hosts/$slug"
              params={{ slug: h.slug } as never}
              className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
            >
              <HostArtwork
                initials={h.initials}
                role={h.role}
                photo={h.headshot}
                name={h.name}
                variant={i % 2 === 0 ? "primary" : "secondary"}
              />
              <h3 className="mt-5 font-display text-[20px] leading-tight text-fg-strong transition group-hover:text-cyan">
                {h.name}
              </h3>
              <p className="mt-2 max-w-sm text-[13px] leading-[1.55] text-fg-muted">
                {h.shortBio}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function RelatedShows({
  currentSlug,
  relatedSlugs,
}: {
  currentSlug: ShowSlug;
  relatedSlugs: ShowSlug[];
}) {
  const related = relatedSlugs
    .filter((s) => s !== currentSlug)
    .map((s) => getShow(s))
    .filter((s): s is Show => Boolean(s));

  if (related.length === 0) return null;

  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Related shows
        </div>
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {related.map((s) => (
            <Link
              key={s.slug}
              to={s.route}
              className="group block overflow-hidden border border-rule bg-navy-800/40 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              <ShowCover show={s} className="border-b border-rule" />
              <div className="p-6">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  {s.shortTitle}
                </div>
                <div className="mt-4 font-display text-[20px] leading-[1.15] text-fg-strong">
                  {s.title}
                </div>
                <p className="mt-3 text-[13px] leading-[1.6] text-fg-muted">
                  {s.tagline}
                </p>
                <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted transition group-hover:text-cyan">
                  Visit show →
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function showHasPaidExtension(slug: ShowSlug): boolean {
  return slug === "call-me-back";
}
