import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PodcastFeedSetup } from "../../components/PodcastFeedSetup";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/account/podcast-feed")({
  component: PodcastFeedPage,
  validateSearch: (search: Record<string, unknown>): { feed?: number } => {
    const n = Number(search.feed);
    return Number.isInteger(n) && n > 0 ? { feed: n } : {};
  },
});

function PodcastFeedPage() {
  const navigate = useNavigate();
  const routeNavigate = Route.useNavigate();
  const { feed } = Route.useSearch();
  const { state } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
      return;
    }
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

  if (state.kind === "guest" || state.me.tier !== "ark-plus-member") return null;

  return (
    <PodcastFeedSetup
      me={state.me}
      feedParam={feed}
      onSelectFeed={(id) => void routeNavigate({ search: { feed: id } })}
      onClearFeed={() => void routeNavigate({ search: {} })}
    />
  );
}
