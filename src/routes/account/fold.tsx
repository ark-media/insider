import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isCircleMember, useSubscriberAuth } from "../../lib/subscriberAuth";
import { CommunityAppLinks } from "../../components/CommunityAppLinks";

export const Route = createFileRoute("/account/fold")({
  component: FoldTab,
});

// The Fold tab: the hand-off into the Circle app. The account session already
// carries the member through SSO, so the only job here is getting the app in
// front of them — hence three links and nothing else.
function FoldTab() {
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "member" && !isCircleMember(state)) {
      void navigate({ to: "/account" });
    }
  }, [state, navigate]);

  if (state.kind !== "member" || !state.me.entitlements.circle) return null;

  return (
    <section>
      <div className="page-section">
        <h2 className="text-h2">The Fold</h2>
        <p className="mt-4 max-w-2xl text-body">
          The Fold is the main event. Open it in the app — you're signed in
          here, so you'll be signed in there too.
        </p>
        <CommunityAppLinks className="mt-8" placement="account_fold_tab" />
      </div>
    </section>
  );
}
