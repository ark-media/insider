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
import { setTokenGetter } from "./tokenStore";

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
  const { isAuthenticated, isLoading, getAccessTokenSilently, logout } = useAuth0();
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
    if (isLoading) return;
    if (!isAuthenticated) {
      setState({ kind: "guest" });
      return;
    }
    void refresh();
  }, [isAuthenticated, isLoading, refresh]);

  const signOut = useCallback(() => {
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
