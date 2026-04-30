import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { fetchMe, signOut as apiSignOut, type Me } from "./auth";

export type SubscriberAuthState =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "member"; me: Me };

type SubscriberAuthValue = {
  state: SubscriberAuthState;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SubscriberAuthContext = createContext<SubscriberAuthValue | null>(null);

export function SubscriberAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SubscriberAuthState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    const me = await fetchMe();
    setState(me ? { kind: "member", me } : { kind: "guest" });
  }, []);

  const signOut = useCallback(async () => {
    await apiSignOut();
    setState({ kind: "guest" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
