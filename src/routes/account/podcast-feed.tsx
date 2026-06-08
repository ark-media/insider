import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SetupFlow } from "../../components/SetupFlow";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/account/podcast-feed")({
  component: PodcastFeedPage,
});

function PodcastFeedPage() {
  const navigate = useNavigate();
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

  return <SetupFlow me={state.me} />;
}
