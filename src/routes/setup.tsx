import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PodcastFeedSetup } from "../components/PodcastFeedSetup";
import { isArkPlusMember, useSubscriberAuth } from "../lib/subscriberAuth";

// The component's own gate redirects guests and free users to /plus.
export const Route = createFileRoute("/setup")({
  component: SetupPage,
  // The show id (`pod_<uuid>`), not the rotating feed token — see UserFeed.id.
  validateSearch: (search: Record<string, unknown>): { feed?: string } => {
    const v = search.feed;
    return typeof v === "string" && v.length > 0 && v.length <= 64
      ? { feed: v }
      : {};
  },
});

function SetupPage() {
  const navigate = useNavigate();
  const routeNavigate = Route.useNavigate();
  const { feed } = Route.useSearch();
  const { state } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
      return;
    }
    // Free accounts have no private feed to set up. Send them to the upgrade
    // pitch so the route can't be reached by URL-poking.
    if (state.kind === "member" && !isArkPlusMember(state)) {
      void navigate({ to: "/plus" });
    }
  }, [state, navigate]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest") return null;
  if (!state.me.entitlements.arkPlus) return null;

  return (
    <PodcastFeedSetup
      me={state.me}
      feedParam={feed}
      onSelectFeed={(id) => void routeNavigate({ search: { feed: id } })}
      onClearFeed={() => void routeNavigate({ search: {} })}
    />
  );
}
