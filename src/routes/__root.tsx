import { Outlet, createRootRoute, useMatches } from "@tanstack/react-router";
import { PublicMasthead } from "../components/PublicMasthead";
import { Footer } from "../components/Footer";
import { AnnouncementBanner } from "../components/AnnouncementBanner";
import { AuthErrorNotice } from "../components/AuthErrorNotice";
import { SubscriberAuthProvider, useSubscriberAuth } from "../lib/subscriberAuth";

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
  const chromeless = matches.some((m) => m.staticData?.chromeless);

  // Block rendering while /api/me is in-flight for a likely session (the
  // provider seeds "loading" only when a session-presence cookie exists).
  if (state.kind === "loading") {
    return (
      <div role="status" aria-label="Loading" className="flex min-h-dvh items-center justify-center bg-navy-900">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="bg-app min-h-dvh font-sans text-ink">
      {chromeless ? null : (
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
      )}
      {chromeless ? null : (
        <>
          <AnnouncementBanner />
          {/* <LiveStatus /> */}
          <PublicMasthead />
          <AuthErrorNotice />
        </>
      )}
      <div id="main-content" className="page-stripes">
        <Outlet />
      </div>
      {chromeless ? null : <Footer />}
    </div>
  );
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    chromeless?: boolean;
  }
}
