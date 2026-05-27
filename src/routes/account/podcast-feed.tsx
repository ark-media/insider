import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SetupFlow } from "../../components/SetupFlow";
import { fetchMe } from "../../lib/auth";
import { useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/account/podcast-feed")({
  staticData: { chromeless: true },
  beforeLoad: async () => {
    const me = await fetchMe();
    if (!me) throw redirect({ to: "/plus" });
    // The private podcast feed is a paid feature — only subscribers have a
    // Simplecast record to set up.
    if (me.tier !== "subscriber") throw redirect({ to: "/plus" });
    return { me };
  },
  component: PodcastFeedPage,
});

function PodcastFeedPage() {
  const { me } = Route.useRouteContext();
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, navigate]);

  return <SetupFlow me={me} />;
}
