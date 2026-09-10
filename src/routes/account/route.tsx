import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { PageShell } from "../../components/PageShell";
import { ContentError } from "../../components/ContentError";
import { AccountTabs } from "../../components/account/AccountTabs";

// Layout for the whole /account section.
//
// The shell owns everything the tabs share: the auth gate, the greeting, and
// the tab bar. Each tab route then renders only its own body, so the header
// doesn't reflow between tabs and there's exactly one place that decides what
// happens to a signed-out visitor.
//
// /account/billing is deliberately NOT a tab — it's the detail page behind the
// Membership tab's "Manage billing", and shows up with Membership selected.
export const Route = createFileRoute("/account")({
  component: AccountLayout,
});

function AccountLayout() {
  const navigate = useNavigate();
  const { state, authError, refresh, isAdmin } = useSubscriberAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    // Don't bounce to /plus when "guest" is just an unreachable /api/me — the
    // error+retry below owns that case.
    if (!authError && state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, authError, navigate]);

  if (authError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900 p-6">
        <div className="w-full max-w-md">
          <ContentError
            message="We couldn't load your account. Refresh to try again."
            onRetry={refresh}
          />
        </div>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest") return null;

  const { me } = state;

  return (
    <PageShell
      title={me.firstName ? `Welcome back, ${me.firstName}.` : "Welcome back."}
      lede={
        me.tier === "free"
          ? `Signed in as ${me.email}. Manage what lands in your inbox, or join Ark+ for the private feed and the Fold.`
          : `Signed in as ${me.email}. Everything in your membership, in one place.`
      }
    >
      <AccountTabs
        pathname={pathname}
        entitlements={me.entitlements}
        isAdmin={isAdmin}
      />
      <Outlet />
    </PageShell>
  );
}
