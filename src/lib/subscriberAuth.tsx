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
import { hasCheckoutCookie, setTokenGetter } from "./tokenStore";
import { identifyUser, resetIdentity } from "./observability";
import { AUTH0_TIER_CLAIM } from "../../shared/auth0-claims";

export type SubscriberAuthState =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "member"; me: Me };

type SubscriberAuthValue = {
  state: SubscriberAuthState;
  refresh: () => Promise<void>;
  signOut: () => void;
};

const SubscriberAuthContext = createContext<SubscriberAuthValue | null>(null);

export function SubscriberAuthProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, getAccessTokenSilently, logout, user } = useAuth0();
  const [state, setState] = useState<SubscriberAuthState>({ kind: "loading" });

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

  // Tie analytics/error identity to the auth lifecycle. Tier comes from the
  // Auth0 token claim when present; falls back to "has SC feeds" so a fresh
  // subscriber identifies correctly before the Action propagates the claim.
  useEffect(() => {
    if (state.kind === "member") {
      const tierClaim = user?.[AUTH0_TIER_CLAIM];
      const tier: "subscriber" | "free" =
        tierClaim === "subscriber" || state.me.feeds.length > 0 ? "subscriber" : "free";
      identifyUser({
        id: user?.sub ?? state.me.email,
        email: state.me.email,
        tier,
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
    <SubscriberAuthContext.Provider value={{ state, refresh, signOut }}>
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
