import { Outlet, createRootRoute, useMatches } from "@tanstack/react-router";
import { PublicMasthead } from "../components/PublicMasthead";
import { Footer } from "../components/Footer";
import { LiveStatus } from "../components/LiveStatus";
import { SubscriberAuthProvider } from "../lib/subscriberAuth";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const matches = useMatches();
  const chromeless = matches.some((m) => m.staticData?.chromeless);

  return (
    <SubscriberAuthProvider>
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
    </SubscriberAuthProvider>
  );
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    chromeless?: boolean;
  }
}
