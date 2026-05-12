import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SetupFlow } from "../components/SetupFlow";
import { useSubscriberAuth } from "../lib/subscriberAuth";

export const Route = createFileRoute("/setup")({
  staticData: { chromeless: true },
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, navigate]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest") return null;

  return <SetupFlow me={state.me} />;
}
