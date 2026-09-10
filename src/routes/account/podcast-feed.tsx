import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PodcastFeedSetup } from "../../components/PodcastFeedSetup";
import { trackEvent } from "../../lib/analytics";
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

  // Read the return marker once, at mount, so the confirmation survives us
  // stripping it from the URL below.
  const [spotifyLinked] = useState(() => spotify === "linked");
  const consumed = useRef(false);

  // Coming back from Beehiiv's Spotify consent flow. Check the shows off (the
  // `podcasts.private_feed.activated` webhook is authoritative but can lag by
  // minutes) and drop the marker, so a reload or a copied link doesn't
  // re-announce a link that didn't just happen. The ref guard matters: marking
  // feeds set up updates auth state, which re-runs this effect before the
  // router has applied the new search params.
  useEffect(() => {
    if (spotify !== "linked" || state.kind !== "member" || consumed.current) {
      return;
    }
    consumed.current = true;
    const ids = state.me.feeds.map((f) => f.id);
    trackEvent("feed_spotify_linked", { feed_count: ids.length });
    markFeedsSetUp(ids);
    void routeNavigate({
      search: feed ? { feed } : {},
      replace: true,
    });
  }, [spotify, state, feed, markFeedsSetUp, routeNavigate]);

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
