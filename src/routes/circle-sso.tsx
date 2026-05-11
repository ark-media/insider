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
      // Auth0 path uses a Bearer header; the post-checkout-cookie path
      // attaches via credentials:'include' and getToken() returns null.
      const token = await getToken();
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch("/api/circle-sso", {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ return_to: return_to ?? "/" }),
      });

      if (res.status === 401) {
        void loginWithRedirect({ appState: { returnTo: selfPath } });
        return;
      }

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
