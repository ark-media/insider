import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { fetchMe, type Me } from "./auth";
import { fetchAdminMe } from "./admin";
import { hasCheckoutCookie, setTokenGetter } from "./tokenStore";
import { identifyUser, resetIdentity } from "./observability";

export type SubscriberAuthState =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "member"; me: Me };

type SubscriberAuthValue = {
  state: SubscriberAuthState;
  refresh: () => Promise<void>;
  signOut: () => void;
  // Whether the signed-in user holds the "admin" role, per /api/admin/me
  // (which re-verifies the Auth0 token server-side). `adminLoading` is true
  // until that first check resolves for an authenticated user.
  isAdmin: boolean;
  adminLoading: boolean;
};

const SubscriberAuthContext = createContext<SubscriberAuthValue | null>(null);

export function SubscriberAuthProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, getAccessTokenSilently, logout, user } = useAuth0();
  const [state, setState] = useState<SubscriberAuthState>({ kind: "loading" });
  const [admin, setAdmin] = useState<{ loading: boolean; isAdmin: boolean }>({
    loading: true,
    isAdmin: false,
  });

  // Make getAccessTokenSilently available to non-React code (fetchMe, etc.)
  useEffect(() => {
    setTokenGetter(() => getAccessTokenSilently());
  }, [getAccessTokenSilently]);

  const refresh = useCallback(async () => {
    const me = await fetchMe();
    setState(me ? { kind: "member", me } : { kind: "guest" });
  }, []);

  useEffect(() => {
    // The post-checkout session lives in an httpOnly cookie that JS can't
    // read, so we rely on the sibling "present" cookie as a hint that
    // /api/me will succeed even though Auth0 hasn't authenticated the user.
    // `refresh` is async and only setStates after `await fetchMe()`, so the
    // synchronous-setState rule is a false positive here.
    if (hasCheckoutCookie()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
      return;
    }
    if (isLoading) return;
    if (!isAuthenticated) {
      setState({ kind: "guest" });
      return;
    }
    void refresh();
  }, [isAuthenticated, isLoading, refresh]);

  // Resolve admin status from the server (authoritative — it re-verifies the
  // access token's role claim). Only authenticated Auth0 sessions can be admin;
  // the post-checkout cookie session never is, so skip the call for it.
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      // Resetting to the known guest state on sign-out; not a cascading render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAdmin({ loading: false, isAdmin: false });
      return;
    }
    let cancelled = false;
    void fetchAdminMe().then((r) => {
      if (!cancelled) setAdmin({ loading: false, isAdmin: r.isAdmin });
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading]);

  // Tie analytics/error identity to the auth lifecycle. /api/me returns the
  // authoritative tier (SC presence wins over a stale JWT claim).
  useEffect(() => {
    if (state.kind === "member") {
      identifyUser({
        id: user?.sub ?? state.me.email,
        email: state.me.email,
        tier: state.me.tier,
      });
    } else if (state.kind === "guest") {
      resetIdentity();
    }
  }, [state, user]);

  const signOut = useCallback(() => {
    // Clear the server-set checkout cookies before Auth0 takes over the tab.
    // Fire-and-forget; the Auth0 redirect happens regardless.
    void fetch("/api/signout", { method: "POST", credentials: "include" });
    logout({ logoutParams: { returnTo: window.location.origin } });
  }, [logout]);

  return (
    <SubscriberAuthContext.Provider
      value={{
        state,
        refresh,
        signOut,
        isAdmin: admin.isAdmin,
        adminLoading: admin.loading,
      }}
    >
      {children}
    </SubscriberAuthContext.Provider>
  );
}

export function useSubscriberAuth(): SubscriberAuthValue {
  const ctx = useContext(SubscriberAuthContext);
  if (!ctx) {
    throw new Error(
      "useSubscriberAuth must be used inside <SubscriberAuthProvider>",
    );
  }
  return ctx;
}
