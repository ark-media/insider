import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SetupFlow } from "../../components/SetupFlow";
import { useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/account/podcast-feed")({
  staticData: { chromeless: true },
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
    if (state.kind === "member" && state.me.tier !== "subscriber") {
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

  if (state.kind === "guest" || state.me.tier !== "subscriber") return null;

  return <SetupFlow me={state.me} />;
}
