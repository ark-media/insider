import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { FeedSetup } from "../components/FeedSetup";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { PageShell } from "../components/PageShell";
import { isArkPlusMember, useSubscriberAuth } from "../lib/subscriberAuth";

// The component's own gate redirects guests and free users to /plus.
export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
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
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Account", to: "/account" },
            { label: "Podcast feed" },
          ]}
        />
      }
      title="Now let's get you listening."
      lede="Your Ark+ membership unlocks a private feed. Add it to the podcast app you already use."
    >
      <FeedSetup feeds={state.me.feeds} />
    </PageShell>
  );
}
