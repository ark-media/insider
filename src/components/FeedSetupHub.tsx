import { useMemo } from "react";
import { Breadcrumbs } from "./Breadcrumbs";
import { SpotifyIcon } from "./PlatformIcons";
import { feedIsSetUp, type UserFeed } from "../lib/auth";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { trackEvent } from "../lib/analytics";
import { OutboundLink } from "./OutboundLink";

// The landing surface for private-feed setup. Two paths, in priority order:
//   1. Spotify — link once, follow every show in the network automatically.
//      This is the clear default action, up top.
//   2. Set up each show by hand — every feed listed explicitly, each with its
//      own status, so a member can see "3 of 6 set up" and finish the rest.
// Picking a show drops into that feed's per-app SetupFlow (via onSelect).
export function FeedSetupHub({
  feeds,
  onSelect,
  embedded = false,
}: {
  feeds: UserFeed[];
  onSelect: (feedId: number) => void;
  /**
   * Rendered inside the /account shell (the Podcasts tab) rather than as a
   * page of its own. The shell already supplies the <main> element, the page
   * gutter and the section nav, so this drops its own frame and breadcrumbs
   * and keeps only the setup content.
   */
  embedded?: boolean;
}) {
  const { markFeedsSetUp } = useSubscriberAuth();

  const doneCount = useMemo(
    () => feeds.filter((f) => feedIsSetUp(f)).length,
    [feeds],
  );
  const total = feeds.length;
  const allDone = total > 0 && doneCount === total;

  // The Spotify account-link is network-wide: the same link on any feed grants
  // the whole network. Take the first one we find.
  const spotifyUrl = useMemo(() => {
    for (const f of feeds) {
      const match = f.apps?.find((a) => a.app === "spotify");
      if (match) return match.url;
    }
    return "";
  }, [feeds]);

  const linkSpotify = () => {
    trackEvent("feed_spotify_linked", { feed_count: total });
    // One link covers the network — optimistically check off every show.
    markFeedsSetUp(feeds.map((f) => f.id));
  };

  const Frame = embedded ? "section" : "main";

  return (
    <Frame className="relative text-fg-strong">
      <div
        className={
          embedded
            ? "mx-auto max-w-[1040px] px-6 pb-16 pt-10 sm:px-10"
            : "mx-auto max-w-[1040px] px-6 pb-24 pt-8 sm:px-10 sm:pb-28"
        }
      >
        {embedded ? null : (
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Account", to: "/account" },
              { label: "Podcast feed" },
            ]}
            className="mb-10"
          />
        )}

        {/* Masthead + progress */}
        <div className="rise rise-1 flex flex-col gap-10 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4.2vw,3.4rem)]">
                Now let's get you
              </span>
              <span className="display-upright block text-[clamp(1.9rem,4.2vw,3.4rem)]">
                <span className="display text-cyan">listening.</span>
              </span>
            </h1>
            <p className="mt-5 max-w-md text-body-lg">
              Your Ark+ membership unlocks a private feed for every show in the
              network. Link Spotify once to get them all — or add each show to
              the app you already use.
            </p>
          </div>

          {total > 0 ? (
            <ProgressMeter done={doneCount} total={total} allDone={allDone} />
          ) : null}
        </div>

        {total === 0 ? (
          <>
            <div className="mt-12 hairline" />
            <div className="mt-12 border border-rule bg-navy-900/60 p-6 text-body-sm text-fg">
              No private feeds on your membership yet. If you just joined, give
              it a minute and refresh — they appear here automatically.
            </div>
          </>
        ) : (
          <>
            {/* Path 1 — Spotify, the one-click default */}
            {spotifyUrl ? (
              <>
                <div className="mt-12 hairline" />
                <SpotifyHero url={spotifyUrl} onLink={linkSpotify} />
              </>
            ) : null}

            {/* Path 2 — every show, set up by hand */}
            <div className="mt-16 flex items-baseline gap-x-4">
              <span className="label font-display font-bold text-fg-faint">
                {spotifyUrl ? "Or one at a time" : "Set up your shows"}
              </span>
              <h2 className="text-fg-strong">
                <span className="display-upright text-[clamp(1.3rem,2.6vw,1.9rem)]">
                  Every show in the network
                </span>
              </h2>
            </div>
            <p className="mt-2 max-w-xl text-body-sm">
              Add each show to Apple Podcasts, Overcast, Pocket Casts, or any app
              you like. The more you set up, the less you'll miss.
            </p>

            <ul className="rise rise-2 mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {feeds.map((f) => (
                <ShowRow
                  key={f.id}
                  feed={f}
                  done={feedIsSetUp(f)}
                  onSelect={() => onSelect(f.id)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Frame>
  );
}

function ProgressMeter({
  done,
  total,
  allDone,
}: {
  done: number;
  total: number;
  allDone: boolean;
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="w-full shrink-0 border border-rule bg-navy-900/60 p-5 sm:w-[248px]">
      <div className="flex items-baseline justify-between">
        <span className="label font-display font-bold text-fg-strong">
          {allDone ? "All set" : "Setup"}
        </span>
        <span className="font-display text-[15px] font-bold tracking-cta text-cyan">
          {done}
          <span className="text-fg-muted">/{total}</span>
        </span>
      </div>
      <div
        className="mt-4 h-1.5 w-full overflow-hidden bg-navy-800"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${done} of ${total} shows set up`}
      >
        <div
          className="h-full bg-cyan transition-[width] duration-700 ease-[cubic-bezier(.16,1,.3,1)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-3 text-body-sm text-fg-muted">
        {allDone
          ? "You're following the whole network. Nice."
          : `${total - done} ${total - done === 1 ? "show" : "shows"} left to add.`}
      </p>
    </div>
  );
}

function SpotifyHero({ url, onLink }: { url: string; onLink: () => void }) {
  return (
    <section className="rise rise-1 mt-12 border border-cyan/40 bg-cyan/[0.06] p-6 sm:p-8">
      <div className="flex items-center gap-3 label text-cyan">
        <span className="h-px w-6 bg-cyan" />
        Fastest way in
      </div>
      <div className="mt-5 flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-8">
        <SpotifyIcon className="size-14 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[clamp(1.3rem,2.6vw,1.9rem)] font-bold uppercase leading-[1.05] tracking-[0.01em] text-fg-strong">
            Link Spotify once — get every show
          </h2>
          <p className="mt-3 max-w-lg text-body">
            Connect your Spotify account and your entire network of private
            feeds follows automatically. No adding shows one by one — new shows
            we launch show up on their own, too.
          </p>
        </div>
        {/* Keeps its own `feed_spotify_linked` (which carries feed_count) and
            additionally reports the hand-off through the outbound chokepoint,
            so Spotify traffic shows up in the outbound map alongside every
            other off-domain link. */}
        <OutboundLink
          href={url}
          platform="spotify"
          placement="setup_hub_spotify"
          rel="noreferrer"
          onClick={onLink}
          className="group inline-flex shrink-0 items-center justify-center gap-3 bg-cyan px-6 py-3.5 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Link my Spotify
          <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
            →
          </span>
        </OutboundLink>
      </div>
    </section>
  );
}

function ShowRow({
  feed,
  done,
  onSelect,
}: {
  feed: UserFeed;
  done: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="group flex w-full items-center gap-4 border border-rule bg-navy-900/40 p-4 text-left transition hover:border-cyan/60 hover:bg-fg-strong/[0.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <div className="relative aspect-square w-16 shrink-0 overflow-hidden bg-navy-900 shadow-cover ring-1 ring-rule">
          {feed.image_url ? (
            <img
              src={feed.image_url}
              alt={feed.name}
              width={128}
              height={128}
              className="h-full w-full object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-full w-full items-center justify-center font-display text-2xl font-bold text-cyan"
            >
              {feed.name.charAt(0)}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate font-display text-[16px] font-bold leading-[1.2] text-fg-strong">
            {feed.name}
          </span>
          <StatusBadge done={done} />
        </div>
        <span
          className={`shrink-0 text-body-sm transition ${
            done
              ? "text-fg-muted group-hover:text-cyan"
              : "inline-flex items-center gap-2 text-fg-muted group-hover:text-cyan"
          }`}
        >
          {done ? "Manage" : "Set up"}
          <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
            →
          </span>
        </span>
      </button>
    </li>
  );
}

function StatusBadge({ done }: { done: boolean }) {
  return done ? (
    <span className="mt-1.5 inline-flex items-center gap-1.5 text-body-sm text-cyan">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        aria-hidden="true"
      >
        <path d="M5 12.5 10 17.5 19 6.5" />
      </svg>
      Set up
    </span>
  ) : (
    <span className="mt-1.5 inline-flex items-center gap-1.5 text-body-sm text-fg-muted">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-fg-faint" />
      Not set up yet
    </span>
  );
}
