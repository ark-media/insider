import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PodcastFeedSetup } from "../../components/PodcastFeedSetup";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/account/podcast-feed")({
  component: PodcastsTab,
  validateSearch: (search: Record<string, unknown>): { feed?: number } => {
    const n = Number(search.feed);
    return Number.isInteger(n) && n > 0 ? { feed: n } : {};
  },
});

// The Podcasts tab. Auth and the greeting belong to the /account layout; this
// only has to turn away a member without the Ark+ axis, who has no private
// feed to set up.
function PodcastsTab() {
  const navigate = useNavigate();
  const routeNavigate = Route.useNavigate();
  const { feed } = Route.useSearch();
  const { state } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "member" && !isArkPlusMember(state)) {
      void navigate({ to: "/account" });
    }
  }, [state, navigate]);

  if (state.kind !== "member" || !state.me.entitlements.arkPlus) return null;

  return (
    <PodcastFeedSetup
      me={state.me}
      feedParam={feed}
      onSelectFeed={(id) => void routeNavigate({ search: { feed: id } })}
      onClearFeed={() => void routeNavigate({ search: {} })}
      embedded
    />
  );
}
