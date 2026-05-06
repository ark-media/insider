import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { getToken } from "../lib/tokenStore";
import { useSubscriberAuth } from "../lib/subscriberAuth";

export const Route = createFileRoute("/circle-sso")({
  validateSearch: (search: Record<string, unknown>) => ({
    return_to:
      typeof search.return_to === "string" ? search.return_to : undefined,
  }),
  component: CircleSSOBridge,
  staticData: { chromeless: true },
});

function CircleSSOBridge() {
  const { return_to } = Route.useSearch();
  const { state } = useSubscriberAuth();
  const { loginWithRedirect } = useAuth0();
  const didRedirect = useRef(false);

  useEffect(() => {
    if (state.kind === "loading" || didRedirect.current) return;
    didRedirect.current = true;

    const selfPath = `/circle-sso${return_to ? `?return_to=${encodeURIComponent(return_to)}` : ""}`;

    if (state.kind === "guest") {
      void loginWithRedirect({ appState: { returnTo: selfPath } });
      return;
    }

    void (async () => {
      const token = await getToken();
      if (!token) {
        void loginWithRedirect({ appState: { returnTo: selfPath } });
        return;
      }

      const res = await fetch("/api/circle-sso", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ return_to: return_to ?? "/" }),
      });

      const data = (await res.json()) as { redirect_url?: string };
      if (data.redirect_url) {
        window.location.href = data.redirect_url;
      }
    })();
  }, [state.kind, return_to, loginWithRedirect]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-navy-900">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-cyan" />
    </div>
  );
}
