import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell } from "../components/PageShell";

export const Route = createFileRoute("/israel-votes")({
  component: IsraelVotesPage,
});

const FEATURED_VIDEO_ID = "1ngquxQAMmY";

type Explainer = {
  title: string;
  show: string;
  videoId: string;
  audioUrl: string;
};

const EXPLAINERS: Explainer[] = [
  {
    title: "The State of the Israeli Right",
    show: "For Heaven's Sake",
    videoId: "LzEUuRnBXwM",
    audioUrl:
      "https://cdn.simplecast.com/audio/73e4172a-7831-48cf-a6a9-390097bd76d3/episodes/1ca38b66-26ce-4908-beef-891eb86a696a/audio/3f83cec4-1185-4b6f-a392-61251271773a/default_tc.mp3",
  },
  {
    title: "The Only-Bibi Camp vs Never-Bibi Camp",
    show: "Call Me Back · with Ari Shavit",
    videoId: "aPqv68qM9a4",
    audioUrl:
      "https://cdn.simplecast.com/audio/95ea4d0c-35c7-4ac7-a410-7d9f02ee3ded/episodes/f88f8164-86a1-45fd-9d8d-d77a9b8a8cdb/audio/c20e999c-1f49-47ca-8c97-cb88951763e7/default_tc.mp3",
  },
  {
    title: "The State of the Israeli Center",
    show: "For Heaven's Sake",
    videoId: "Hjfr3G5DuwE",
    audioUrl:
      "https://cdn.simplecast.com/audio/73e4172a-7831-48cf-a6a9-390097bd76d3/episodes/06080d81-fbb6-4b97-92ae-ed7985d20af6/audio/8655d052-c5f4-4e7f-a6a6-af767983a809/default_tc.mp3",
  },
];

type Track = {
  show: "CMB" | "FHS" | "WYN" | "ICMB";
  title: string;
  audioUrl: string;
};

const SHOW_LABEL: Record<Track["show"], string> = {
  CMB: "Call Me Back",
  FHS: "For Heaven's Sake",
  WYN: "What's Your Number?",
  ICMB: "Inside Call Me Back",
};

const PLAYLIST: Track[] = [
  {
    show: "CMB",
    title: "A Political Shakeup in Israel? — with Amit Segal and Nadav Eyal",
    audioUrl:
      "https://cdn.simplecast.com/media/audio/transcoded/e9010e3f-7aa0-43d4-a1f5-6e638d5a744e/95ea4d0c-35c7-4ac7-a410-7d9f02ee3ded/episodes/audio/group/88fe4c13-5bcf-4128-a754-de77c8d04cfd/group-item/c32587f8-a9a6-47a3-8aa2-c3fc475120df/128_default_tc.mp3",
  },
  {
    show: "CMB",
    title: "The Political Landscape — with Nadav Eyal and Amit Segal",
    audioUrl:
      "https://cdn.simplecast.com/audio/95ea4d0c-35c7-4ac7-a410-7d9f02ee3ded/episodes/ac9dd7e1-0001-498c-af25-d2064865d8ee/audio/96aad3de-7d4f-410d-bcce-93efd2c70275/default_tc.mp3",
  },
  {
    show: "FHS",
    title: "Election Currents",
    audioUrl:
      "https://cdn.simplecast.com/audio/73e4172a-7831-48cf-a6a9-390097bd76d3/episodes/929b7154-fde5-4b9b-944a-ce0922bd7c03/audio/c9d1e359-993d-490a-b8c8-e04b06147ec0/default_tc.mp3",
  },
  {
    show: "WYN",
    title: "From War Economy to Election Economy",
    audioUrl:
      "https://cdn.simplecast.com/audio/0f41eccf-6011-4668-9afc-32b71bc38e7b/episodes/b7cd3497-3063-4ba3-84ae-56819e9be45a/audio/f9465660-ad76-4b8d-9c2a-c9516c68508d/default_tc.mp3",
  },
  {
    show: "FHS",
    title: "Bennett 2026",
    audioUrl:
      "https://cdn.simplecast.com/audio/73e4172a-7831-48cf-a6a9-390097bd76d3/episodes/45e310f2-a641-4068-979e-0ba2b7ced288/audio/7e9d64fb-6f6c-48ea-b4d6-c0b7200ad76e/default_tc.mp3",
  },
  {
    show: "ICMB",
    title: "Sneak Peek: Live with Tal Becker and Nadav Eyal",
    audioUrl:
      "https://cdn.simplecast.com/audio/95ea4d0c-35c7-4ac7-a410-7d9f02ee3ded/episodes/7afd9409-9c7e-4789-80be-effb6ca827a5/audio/b3f42247-94b4-48e4-a832-1b94061debd6/default_tc.mp3",
  },
  {
    show: "FHS",
    title: "The State of the Israeli Center",
    audioUrl:
      "https://cdn.simplecast.com/audio/73e4172a-7831-48cf-a6a9-390097bd76d3/episodes/06080d81-fbb6-4b97-92ae-ed7985d20af6/audio/8655d052-c5f4-4e7f-a6a6-af767983a809/default_tc.mp3",
  },
  {
    show: "WYN",
    title: "Is Israel's 2026 Budget a Red Flag?",
    audioUrl:
      "https://cdn.simplecast.com/audio/0f41eccf-6011-4668-9afc-32b71bc38e7b/episodes/1a480d3c-85c0-4930-b9ff-070a9cd7558e/audio/77704ec9-9dd7-43a1-8836-e16d093e23a7/default_tc.mp3",
  },
  {
    show: "CMB",
    title: "The Only-Bibi Camp vs Never-Bibi Camp",
    audioUrl:
      "https://cdn.simplecast.com/audio/95ea4d0c-35c7-4ac7-a410-7d9f02ee3ded/episodes/f88f8164-86a1-45fd-9d8d-d77a9b8a8cdb/audio/c20e999c-1f49-47ca-8c97-cb88951763e7/default_tc.mp3",
  },
  {
    show: "FHS",
    title: "The State of the Israeli Right",
    audioUrl:
      "https://cdn.simplecast.com/audio/73e4172a-7831-48cf-a6a9-390097bd76d3/episodes/1ca38b66-26ce-4908-beef-891eb86a696a/audio/3f83cec4-1185-4b6f-a392-61251271773a/default_tc.mp3",
  },
  {
    show: "CMB",
    title: "Netanyahu Seeks Pardon",
    audioUrl:
      "https://cdn.simplecast.com/audio/95ea4d0c-35c7-4ac7-a410-7d9f02ee3ded/episodes/bc0ea99c-85e2-4a52-a1a4-6a421525ecbf/audio/d677d9c9-1056-46df-9410-7bbf953bbfd6/default_tc.mp3",
  },
  {
    show: "FHS",
    title: "Coming Apart",
    audioUrl:
      "https://cdn.simplecast.com/audio/73e4172a-7831-48cf-a6a9-390097bd76d3/episodes/99690807-3cae-4bd7-88d3-96934787ac4e/audio/f8cfdbca-f7d7-4817-9705-3b615f77955f/default_tc.mp3",
  },
];

function IsraelVotesPage() {
  return (
    <PageShell
      eyebrow="Israel Votes"
      title="Tracking the next Israeli election."
      lede="Polls, parties, and the politics behind the headlines — explained the way Call Me Back listeners expect."
    >
      <WatchLatest />
      <Explainers />
      <PlaylistSection />
    </PageShell>
  );
}

function WatchLatest() {
  return (
    <section className="border-t border-white/10 bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Watch the latest
        </div>
        <div className="mt-8 max-w-4xl">
          <YouTubeEmbed videoId={FEATURED_VIDEO_ID} title="Watch the latest Israel Votes update" />
        </div>
      </div>
    </section>
  );
}

function Explainers() {
  return (
    <section className="border-t border-white/10 bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Explainers
        </div>
        <p className="mt-6 max-w-2xl text-[14px] leading-[1.7] text-white/65">
          Background on the camps, the coalitions, and the constituencies
          shaping Israel's next vote — in video and audio.
        </p>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-3">
          {EXPLAINERS.map((e) => (
            <article
              key={e.videoId}
              className="flex flex-col border border-white/12 bg-navy-800/40"
            >
              <YouTubeEmbed videoId={e.videoId} title={e.title} />
              <div className="flex flex-1 flex-col p-6">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  {e.show}
                </div>
                <h3 className="mt-3 font-display text-[20px] leading-[1.2] text-white">
                  {e.title}
                </h3>
                <div className="mt-6">
                  <audio
                    controls
                    preload="none"
                    src={e.audioUrl}
                    className="h-10 w-full"
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PlaylistSection() {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  return (
    <section className="border-t border-white/10 bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Israel Votes playlist
            </div>
            <h2 className="mt-6 max-w-3xl font-display text-[clamp(1.5rem,3vw,2.4rem)] leading-[1.1] text-white">
              The full collection.
            </h2>
            <p className="mt-4 max-w-2xl text-[14px] leading-[1.7] text-white/65">
              Episodes from across the Ark Media network covering the campaign,
              the coalitions, and the questions on the ballot.
            </p>
          </div>
          <span className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45 sm:inline">
            {PLAYLIST.length} episodes
          </span>
        </div>

        <ul className="mt-10 divide-y divide-white/10 border-y border-white/10">
          {PLAYLIST.map((track, idx) => {
            const isActive = activeIdx === idx;
            return (
              <li key={track.audioUrl}>
                <button
                  type="button"
                  onClick={() => setActiveIdx(isActive ? null : idx)}
                  aria-expanded={isActive}
                  className="group flex w-full items-baseline gap-4 py-4 text-left transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:gap-6"
                >
                  <span className="w-8 shrink-0 font-display text-[13px] tabular-nums text-white/35">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`flex h-7 w-7 shrink-0 items-center justify-center border border-white/25 text-[10px] transition group-hover:border-cyan ${
                      isActive ? "border-cyan bg-cyan/10 text-cyan" : "text-white/70"
                    }`}
                  >
                    {isActive ? "▮▮" : "▶"}
                  </span>
                  <span className="flex-1 text-[14px] leading-[1.45] text-white/85">
                    <span className="font-display tracking-[-0.005em]">
                      {track.title}
                    </span>
                  </span>
                  <span className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45 sm:inline">
                    {SHOW_LABEL[track.show]}
                  </span>
                </button>
                {isActive ? (
                  <div className="pb-5 pl-12 pr-2 sm:pl-[72px]">
                    <audio
                      controls
                      autoPlay
                      preload="auto"
                      src={track.audioUrl}
                      className="h-10 w-full"
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function YouTubeEmbed({ videoId, title }: { videoId: string; title: string }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden border border-white/10 bg-black">
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
