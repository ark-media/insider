import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell } from "../components/PageShell";
import {
  EXPLAINERS,
  PLAYLIST,
  type CuratedEpisode,
  type Explainer,
} from "../data/israelVotes";
import { getShow } from "../data/shows";
import { useEpisodeAudio, type EpisodeAudio } from "../lib/useEpisodeAudio";

export const Route = createFileRoute("/israel-votes")({
  component: IsraelVotesPage,
});

const FEATURED_VIDEO_ID = "1ngquxQAMmY";

function IsraelVotesPage() {
  return (
    <PageShell
      title="Tracking the next Israeli election."
      lede="Polls, parties, and the politics behind the headlines"
    >
      <WatchLatest />
      <Explainers />
      <PlaylistSection />
    </PageShell>
  );
}

function WatchLatest() {
  return (
    <section>
      <div className="page-section">
        <h2 className="label text-cyan">
          Watch the latest
        </h2>
        <div className="mt-8 max-w-4xl">
          <YouTubeEmbed videoId={FEATURED_VIDEO_ID} title="Watch the latest Israel Votes update" />
        </div>
      </div>
    </section>
  );
}

function Explainers() {
  return (
    <section>
      <div className="page-section">
        <h2 className="label text-cyan">
          Explainers
        </h2>
        <p className="mt-6 max-w-2xl text-body-sm">
          Background on the camps, the coalitions, and the constituencies
          shaping Israel's next vote — in video and audio.
        </p>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-3">
          {EXPLAINERS.map((e) => (
            <ExplainerCard key={e.videoId} explainer={e} />
          ))}
        </div>
      </div>
    </section>
  );
}

function PlaylistSection() {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  return (
    <section>
      <div className="page-section">
        <div className="flex items-end justify-between">
          <div>
            <div className="label text-cyan">
              Israel Votes playlist
            </div>
            <h2 className="mt-6 max-w-3xl font-display text-[clamp(1.5rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
              The full collection.
            </h2>
            <p className="mt-4 max-w-2xl text-body-sm">
              Episodes from across the Ark Media network covering the campaign,
              the coalitions, and the questions on the ballot.
            </p>
          </div>
          <span className="hidden label text-fg-muted sm:inline">
            {PLAYLIST.length} episodes
          </span>
        </div>

        <ul className="mt-10 divide-y divide-rule border-y border-rule">
          {PLAYLIST.map((track, idx) => (
            <PlaylistRow
              key={track.episodeId}
              track={track}
              index={idx}
              isActive={activeIdx === idx}
              onToggle={() =>
                setActiveIdx(activeIdx === idx ? null : idx)
              }
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ExplainerCard({ explainer }: { explainer: Explainer }) {
  const audio = useEpisodeAudio(explainer);
  const credit =
    explainer.credit ?? getShow(explainer.show)?.shortTitle ?? "Ark Media";

  return (
    <article className="flex flex-col border border-rule bg-navy-800/40">
      <YouTubeEmbed videoId={explainer.videoId} title={explainer.title} />
      <div className="flex flex-1 flex-col p-6">
        <div className="label text-cyan">{credit}</div>
        <h3 className="mt-3 text-h3">{explainer.title}</h3>
        <div className="mt-6">
          <CuratedAudio audio={audio} title={explainer.title} preload="none" />
        </div>
      </div>
    </article>
  );
}

function PlaylistRow({
  track,
  index,
  isActive,
  onToggle,
}: {
  track: CuratedEpisode;
  index: number;
  isActive: boolean;
  onToggle: () => void;
}) {
  // The reference is only handed to the hook once the row opens, so a visit
  // that browses the list without playing anything makes no requests at all.
  const audio = useEpisodeAudio(isActive ? track : null);
  const showLabel = getShow(track.show)?.shortTitle ?? "";

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isActive}
        className="group flex w-full items-baseline gap-4 py-4 text-left transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:gap-6"
      >
        <span className="w-8 shrink-0 text-body-sm font-display tabular-nums text-fg-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          aria-hidden="true"
          className={`flex h-7 w-7 shrink-0 items-center justify-center border border-rule-strong button-text transition group-hover:border-cyan ${
            isActive ? "border-cyan bg-cyan/10 text-cyan" : "text-fg"
          }`}
        >
          {isActive ? "▮▮" : "▶"}
        </span>
        <span className="flex-1 text-body-sm text-fg">
          <span className="font-display tracking-[-0.005em]">
            {track.title}
          </span>
        </span>
        <span className="hidden label text-fg-muted sm:inline">
          {showLabel}
        </span>
      </button>
      {isActive ? (
        <div className="pb-5 pl-12 pr-2 sm:pl-[72px]">
          <CuratedAudio audio={audio} title={track.title} preload="metadata" />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The player for one curated episode. The url arrives from the podcast host a
 * beat after the row opens, so this owns the three states that implies —
 * resolving, playable, and "the host has nothing for this one".
 */
function CuratedAudio({
  audio,
  title,
  preload,
}: {
  audio: EpisodeAudio;
  title: string;
  preload: "none" | "metadata";
}) {
  if (audio.status === "ready") {
    return (
      <audio
        controls
        preload={preload}
        src={audio.url}
        aria-label={title}
        className="h-10 w-full"
      />
    );
  }
  if (audio.status === "unavailable") {
    return (
      <p className="text-body-sm text-fg-muted">
        This episode isn't available in our player right now — find it in your
        podcast app.
      </p>
    );
  }
  return (
    <div
      className="h-10 w-full animate-pulse rounded bg-fg-strong/8"
      aria-hidden="true"
    />
  );
}

function YouTubeEmbed({ videoId, title }: { videoId: string; title: string }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden border border-rule bg-navy">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`}
        title={title}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
