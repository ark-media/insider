import { FeedPicker } from "./FeedPicker";
import { SetupFlow } from "./SetupFlow";
import type { Me } from "../lib/auth";

// Decides what the podcast-feed surface shows. With a single feed (or none) we
// go straight into the setup flow. With several, we show the cover-art picker
// first; picking one carries its id in the `feed` search param so the setup
// flow can render that show, with a link back to the picker.
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

  if (feeds.length > 1 && !selected) {
    return <FeedPicker feeds={feeds} onSelect={onSelectFeed} />;
  }

  const feed = selected ?? feeds[0] ?? null;
  return (
    <SetupFlow feed={feed} onBack={feeds.length > 1 ? onClearFeed : undefined} />
  );
}
