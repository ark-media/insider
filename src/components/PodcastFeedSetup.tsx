import { FeedSetupHub } from "./FeedSetupHub";
import { SetupFlow } from "./SetupFlow";
import type { Me } from "../lib/auth";

// Decides what the podcast-feed surface shows.
//
// With a single private show — which is the shape today — the hub would be a
// list of one wrapped around a progress meter reading "0 of 1", so we skip
// straight to that show's SetupFlow and never render a picker. The hub is kept
// (and comes back automatically) the moment a second premium show exists,
// which is a config change rather than a code one.
export function PodcastFeedSetup({
  me,
  feedParam,
  onSelectFeed,
  onClearFeed,
  embedded = false,
  spotifyLinked = false,
}: {
  me: Me;
  feedParam: string | undefined;
  onSelectFeed: (feedId: string) => void;
  onClearFeed: () => void;
  /** Rendered inside the /account shell rather than as a page of its own. */
  embedded?: boolean;
  /** The member has just returned from Beehiiv's Spotify consent flow. */
  spotifyLinked?: boolean;
}) {
  const feeds = me.feeds;

  // One feed: it IS the page. No hub, and no "all feeds" link to go back to.
  if (feeds.length === 1) {
    return (
      <SetupFlow
        feed={feeds[0]}
        embedded={embedded}
        spotifyLinked={spotifyLinked}
      />
    );
  }

  const selected = feedParam
    ? feeds.find((f) => f.id === feedParam)
    : undefined;

  if (!selected) {
    return (
      <FeedSetupHub feeds={feeds} onSelect={onSelectFeed} embedded={embedded} />
    );
  }

  return (
    <SetupFlow
      feed={selected}
      onBack={onClearFeed}
      embedded={embedded}
      spotifyLinked={spotifyLinked}
    />
  );
}
