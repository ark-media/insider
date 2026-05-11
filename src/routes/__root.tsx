import { Outlet, createRootRoute, useMatches } from "@tanstack/react-router";
import { useAuth0 } from "@auth0/auth0-react";
import { PublicMasthead } from "../components/PublicMasthead";
import { Footer } from "../components/Footer";
import { LiveStatus } from "../components/LiveStatus";
import { SubscriberAuthProvider, useSubscriberAuth } from "../lib/subscriberAuth";
import { hasCheckoutSession } from "../lib/tokenStore";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <SubscriberAuthProvider>
      <RootContent />
    </SubscriberAuthProvider>
  );
}

function RootContent() {
  const matches = useMatches();
  const { state } = useSubscriberAuth();
  const { isLoading: auth0Loading, isAuthenticated } = useAuth0();
  const chromeless = matches.some((m) => m.staticData?.chromeless);

  // Block rendering only while resolving an authenticated session:
  // - auth0Loading: SDK is processing the redirect callback
  // - isAuthenticated && state.kind === "loading": fetchMe is in-flight after auth resolved
  // - checkout-session: fetchMe is in-flight for a freshly-paid subscriber
  const hasCheckout = hasCheckoutSession();
  const isResolvingSession =
    (auth0Loading && !hasCheckout) ||
    (isAuthenticated && state.kind === "loading") ||
    (hasCheckout && state.kind === "loading");

  if (isResolvingSession) {
    return (
      <div role="status" aria-label="Loading" className="flex min-h-dvh items-center justify-center bg-navy-900">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-cyan" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-navy-900 font-sans text-ink">
      {chromeless ? null : (
        <>
          <LiveStatus />
          <PublicMasthead />
        </>
      )}
      <Outlet />
      {chromeless ? null : <Footer />}
    </div>
  );
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    chromeless?: boolean;
  }
}
