import { Outlet, createRootRoute, useMatches } from "@tanstack/react-router";
import { PublicMasthead } from "../components/PublicMasthead";
import { Footer } from "../components/Footer";
import { AnnouncementBanner } from "../components/AnnouncementBanner";
import { AuthErrorNotice } from "../components/AuthErrorNotice";
import { SupportWidget } from "../components/support/SupportWidget";
import { SubscriberAuthProvider } from "../lib/subscriberAuth";

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
  const chromeless = matches.some((m) => m.staticData?.chromeless);

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
          <PublicMasthead />
          <AuthErrorNotice />
        </>
      )}
      <div id="main-content" className="page-stripes">
        <Outlet />
      </div>
      {chromeless ? null : <Footer />}
      {/* Floating help launcher. Stays on /welcome, /setup and /redeem on
          purpose — those are exactly where people get stuck. It suppresses
          itself on /admin/*. */}
      {chromeless ? null : <SupportWidget />}
    </div>
  );
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    chromeless?: boolean;
  }
}
