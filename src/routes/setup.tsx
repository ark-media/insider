import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PodcastFeedSetup } from "../components/PodcastFeedSetup";
import { isArkPlusMember, useSubscriberAuth } from "../lib/subscriberAuth";

// Not gated by launch mode: this is a member-management surface, and an Ark+
// member needs to set up their feed even during soft launch. The component's
// own gate already redirects guests and free users to /plus (which itself
// redirects to the soft-launch landing).
export const Route = createFileRoute("/setup")({
  component: SetupPage,
  validateSearch: (search: Record<string, unknown>): { feed?: number } => {
    const n = Number(search.feed);
    return Number.isInteger(n) && n > 0 ? { feed: n } : {};
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
    // Free accounts have no Simplecast record to set up. Send them to the
    // upgrade pitch so the route can't be reached by URL-poking.
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
  if (state.me.tier !== "ark-plus-member") return null;

  return (
    <PodcastFeedSetup
      me={state.me}
      feedParam={feed}
      onSelectFeed={(id) => void routeNavigate({ search: { feed: id } })}
      onClearFeed={() => void routeNavigate({ search: {} })}
    />
  );
}
