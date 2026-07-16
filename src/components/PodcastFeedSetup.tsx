import { FeedSetupHub } from "./FeedSetupHub";
import { SetupFlow } from "./SetupFlow";
import type { Me } from "../lib/auth";

// Decides what the podcast-feed surface shows. The landing view is always the
// setup hub — the Spotify one-click path plus every show listed with its setup
// status. Picking a show carries its id in the `feed` search param and drops
// into that feed's per-app SetupFlow, with a link back to the hub.
export function PodcastFeedSetup({
  me,
  feedParam,
  onSelectFeed,
  onClearFeed,
}: {
  me: Me;
  feedParam: number | undefined;
  onSelectFeed: (feedId: number) => void;
  onClearFeed: () => void;
}) {
  const feeds = me.feeds;
  const selected = feedParam
    ? feeds.find((f) => f.id === feedParam)
    : undefined;

  if (!selected) {
    return <FeedSetupHub feeds={feeds} onSelect={onSelectFeed} />;
  }

  return <SetupFlow feed={selected} onBack={onClearFeed} />;
}
