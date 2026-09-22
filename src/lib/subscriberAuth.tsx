import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  persistFeedsSetUp,
  persistSpotifyFollowOpened,
  type Me,
} from "./auth";
import { fetchAdminMe } from "./admin";
import { hasAnySession } from "./tokenStore";
import { identifyUser, resetIdentity } from "./observability";
import { trackEvent } from "./analytics";

export type SubscriberAuthState =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "member"; me: Me };

// True only for a signed-in member who holds the arkPlus axis (the private
// feed) — Ark+ or Bundle. A free user is still `kind: "member"` (Auth0 login,
// no membership), so feed content must always check the entitlement, never gate
// on `kind` alone.
export function isArkPlusMember(state: SubscriberAuthState): boolean {
  return state.kind === "member" && state.me.entitlements.arkPlus;
}

// True for a signed-in member who holds the circle axis (the Fold) — Circle
// or Bundle. Fold surfaces gate on THIS, not arkPlus: the two are
// independent SKUs (§3 risk 5).
export function isCircleMember(state: SubscriberAuthState): boolean {
  return state.kind === "member" && state.me.entitlements.circle;
}

// True for any paying member — holds at least one axis (Ark+, Circle, or
// Bundle). Billing/account-management surfaces gate on this, since a Circle-only
// member has a Stripe subscription to manage just like an Ark+ one.
export function isPaidMember(state: SubscriberAuthState): boolean {
  return (
    state.kind === "member" &&
    (state.me.entitlements.arkPlus || state.me.entitlements.circle)
  );
}

// Which Auth0 connection to open directly, skipping Auth0's picker. Omit it to
// land on the normal login page, which offers Google and the emailed one-time
// code.
//
// No caller passes this today — Auth0 draws the code option itself. Retained as
// the counterpart to the server's allowlist (LOGIN_CONNECTIONS in
// server/routes/auth.ts, which is what actually enforces this set) for support
// deep links.
type SignInConnection =
  | "email"
  | "google-oauth2"
  | "Username-Password-Authentication";

type SignInOpts = {
  signup?: boolean;
  loginHint?: string;
  connection?: SignInConnection;
};

type SubscriberAuthValue = {
  state: SubscriberAuthState;
  refresh: () => Promise<void>;
  // Optimistically mark private feeds as set up: patches the in-memory
  // `me.feeds` (instant check-off in the setup hub) and persists a server-side
  // pending marker so it survives reloads and follows the member across
  // devices. Monotonic — only ever flips a feed to set up, never back. The
  // provider's feed webhook remains authoritative and reconciles on refresh.
  markFeedsSetUp: (feedIds: string[]) => void;
  // Tick a show off the Spotify follow checklist: patches `me.feeds` so the
  // tick shows at once, then writes the server row — the only record. If the
  // write fails the tick is taken back, so the page never shows state the
  // server doesn't hold.
  markSpotifyFollowOpened: (feedId: string) => void;
  // True when /api/me couldn't be reached (network / server error, not a 401).
  // Member-data pages show an error+retry on this; `refresh` is the retry. Kept
  // separate from `state` so a transient outage doesn't ripple a new variant
  // through the ~20 components that switch on `state.kind`.
  authError: boolean;
  // Redirect to the server-side login (BFF). `returnTo` defaults to the
  // current path; `signup` shows Auth0's signup screen.
  signIn: (returnTo?: string, opts?: SignInOpts) => void;
  signOut: () => void;
  // Whether the signed-in user holds the "admin" role, per /api/admin/me
  // (which re-verifies the session server-side). `adminLoading` is true until
  // that first check resolves for a member session.
  isAdmin: boolean;
  adminLoading: boolean;
};

const SubscriberAuthContext = createContext<SubscriberAuthValue | null>(null);

// Floor between refocus revalidations. The staleness this exists to catch is
// measured in minutes, so there is nothing to gain from re-asking on every
// alt-tab — and a page that needs the answer sooner polls on its own.
const REVALIDATE_FLOOR_MS = 10_000;

export function SubscriberAuthProvider({ children }: { children: ReactNode }) {
  // Seed from the JS-readable presence hint so a guest renders immediately
  // without a flash of "loading", and a likely-member shows the spinner while
  // /api/me resolves.
  const [state, setState] = useState<SubscriberAuthState>(() =>
    hasAnySession() ? { kind: "loading" } : { kind: "guest" },
  );
  const [authError, setAuthError] = useState(false);
  const [admin, setAdmin] = useState<{ loading: boolean; isAdmin: boolean }>({
    loading: hasAnySession(),
    isAdmin: false,
  });

  // Spotify follow ticks set this session. A /api/me read that went out
  // before the tick's save committed comes back without it, and would untick
  // the row the member just clicked — so every read is overlaid with these.
  // An id leaves only when its save fails.
  const followOpenedIds = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!hasAnySession()) {
      followOpenedIds.current.clear();
      setState({ kind: "guest" });
      setAuthError(false);
      return;
    }
    try {
      const fetched = await fetchMe();
      const me = fetched && {
        ...fetched,
        feeds: fetched.feeds.map((f) =>
          followOpenedIds.current.has(f.id)
            ? { ...f, spotify_follow_opened: true }
            : f,
        ),
      };
      setState(me ? { kind: "member", me } : { kind: "guest" });
      setAuthError(false);
    } catch {
      // Couldn't reach /api/me. Surface error+retry on member-data pages, but
      // don't flash an existing member back to guest — only resolve the
      // initial "loading" so other consumers aren't stuck.
      setAuthError(true);
      setState((prev) => (prev.kind === "member" ? prev : { kind: "guest" }));
    }
  }, []);

  // Resolve the session once on mount. refresh() may setState synchronously
  // (the guest short-circuit), which is the intended one-shot resolution.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => void refresh(), [refresh]);

  // Re-resolve it when the member comes back to the tab.
  //
  // Everything membership-shaped in the app reads this one snapshot. A
  // server-side change after load (private feeds finishing minting, a tier
  // change, a cancel landing) would stay invisible until a full reload
  // otherwise — "No private feeds on your membership yet" in front of a member
  // who had them.
  //
  // Refetching under a member's feet is safe here by construction: the feed
  // setup page picks its open panel once (FeedSetup's `openId`) rather than
  // deriving it from each render's feeds, and the "I've set this one up" markers
  // are persisted server-side, so neither is lost to a refresh.
  useEffect(() => {
    let lastAt = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastAt < REVALIDATE_FLOOR_MS) return;
      lastAt = Date.now();
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // Resolve admin status from the server (authoritative — it re-verifies the
  // session's role). Only a member session can be admin.
  useEffect(() => {
    if (state.kind === "loading") return;
    if (state.kind === "guest") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAdmin({ loading: false, isAdmin: false });
      return;
    }
    let cancelled = false;
    setAdmin({ loading: true, isAdmin: false });
    void fetchAdminMe().then((r) => {
      if (!cancelled) setAdmin({ loading: false, isAdmin: r.isAdmin });
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  // Tie analytics/error identity to the auth lifecycle.
  useEffect(() => {
    if (state.kind === "member") {
      identifyUser({
        email: state.me.email,
        tier: state.me.tier,
      });
    } else if (state.kind === "guest") {
      resetIdentity();
    }
  }, [state]);

  const markFeedsSetUp = useCallback((feedIds: string[]) => {
    if (feedIds.length === 0) return;
    const ids = new Set(feedIds);
    // Optimistic in-memory patch — instant check-off. Only flip feeds that
    // aren't already set up, so this can never downgrade a confirmed feed.
    setState((prev) =>
      prev.kind === "member"
        ? {
            ...prev,
            me: {
              ...prev.me,
              feeds: prev.me.feeds.map((f) =>
                ids.has(f.id) && !f.activated && !f.pending
                  ? { ...f, pending: true }
                  : f,
              ),
            },
          }
        : prev,
    );
    // Persist server-side (fire-and-forget; swallows its own errors).
    void persistFeedsSetUp(feedIds);
  }, []);

  const markSpotifyFollowOpened = useCallback((feedId: string) => {
    const patch = (opened: boolean) =>
      setState((prev) =>
        prev.kind === "member"
          ? {
              ...prev,
              me: {
                ...prev.me,
                feeds: prev.me.feeds.map((f) =>
                  f.id === feedId ? { ...f, spotify_follow_opened: opened } : f,
                ),
              },
            }
          : prev,
      );
    followOpenedIds.current.add(feedId);
    patch(true);
    void persistSpotifyFollowOpened(feedId).then((ok) => {
      if (ok) return;
      followOpenedIds.current.delete(feedId);
      patch(false);
    });
  }, []);

  const signIn = useCallback((returnTo?: string, opts?: SignInOpts) => {
    const params = new URLSearchParams();
    params.set(
      "returnTo",
      returnTo ?? window.location.pathname + window.location.search,
    );
    if (opts?.signup) params.set("screen_hint", "signup");
    if (opts?.loginHint) params.set("login_hint", opts.loginHint);
    if (opts?.connection) params.set("connection", opts.connection);
    // Fired just before navigating to Auth0; PostHog flushes its queue via
    // sendBeacon on pagehide, so the event survives the redirect.
    trackEvent("login_initiated", { intent: opts?.signup ? "signup" : "login" });
    window.location.assign(`/api/auth/login?${params.toString()}`);
  }, []);

  const signOut = useCallback(() => {
    // The server route clears both session cookies and ends the Auth0 SSO
    // session before returning to the app origin.
    window.location.assign("/api/auth/logout");
  }, []);

  return (
    <SubscriberAuthContext.Provider
      value={{
        state,
        refresh,
        markFeedsSetUp,
        markSpotifyFollowOpened,
        authError,
        signIn,
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
