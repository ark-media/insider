import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { PodcastFeedSetup } from "../../components/PodcastFeedSetup";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";

type PodcastFeedSearch = { feed?: string; spotify?: "linked" };

export const Route = createFileRoute("/account/podcast-feed")({
  component: PodcastsTab,
  validateSearch: (search: Record<string, unknown>): PodcastFeedSearch => {
    // `feed` is the show id (`pod_<uuid>`), not the rotating feed token — see
    // UserFeed.id. `spotify=linked` is the marker Beehiiv redirects back with
    // once Open Access has been authorized (see buildSpotifyHandoff).
    const feed = search.feed;
    return {
      ...(typeof feed === "string" && feed.length > 0 && feed.length <= 64
        ? { feed }
        : {}),
      ...(search.spotify === "linked" ? { spotify: "linked" as const } : {}),
    };
  },
});

// The Podcasts tab. Auth and the greeting belong to the /account layout; this
// only has to turn away a member without the Ark+ axis, who has no private
// feed to set up.
function PodcastsTab() {
  const navigate = useNavigate();
  const routeNavigate = Route.useNavigate();
  const { feed, spotify } = Route.useSearch();
  const { state, markFeedsSetUp } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "member" && !isArkPlusMember(state)) {
      void navigate({ to: "/account" });
    }
  }, [state, navigate]);

  // Coming back from Beehiiv's Spotify consent flow.
  //
  // The marker deliberately stays in the URL. It drives the confirmation the
  // member sees, and holding that in component state instead made it vanish on
  // a re-render — the URL is the one place that survives whatever the router
  // and the auth refresh do to this subtree. It also says something that stays
  // true on a reload.
  //
  // The Spotify CTA already marks the show set up on click, but that request
  // races the same-tab navigation away from the page and can be cancelled
  // mid-flight, so redo it here: this is the path that is guaranteed to run.
  // Marking is idempotent (it only ever flips a feed that isn't already set
  // up), which is what makes it safe to leave the marker in the URL.
  const spotifyLinked = spotify === "linked";
  const marked = useRef(false);
  useEffect(() => {
    if (!spotifyLinked || state.kind !== "member" || marked.current) return;
    marked.current = true;
    markFeedsSetUp(state.me.feeds.map((f) => f.id));
  }, [spotifyLinked, state, markFeedsSetUp]);

  if (state.kind !== "member" || !state.me.entitlements.arkPlus) return null;

  return (
    <PodcastFeedSetup
      me={state.me}
      feedParam={feed}
      spotifyLinked={spotifyLinked}
      onSelectFeed={(id) => void routeNavigate({ search: { feed: id } })}
      onClearFeed={() => void routeNavigate({ search: {} })}
      embedded
    />
  );
}
