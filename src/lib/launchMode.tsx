// Launch mode. One global flag — "soft" (the focused Inside Call Me Back
// experience) or "hard" (the full Ark+ site) — fetched once at startup and read
// across the app to show or hide the Ark+ membership surfaces.
//
// First paint is held (see RootContent in src/routes/__root.tsx) until the
// value resolves, so neither the soft nor the hard surfaces ever flash before
// the flag is known. The default while loading / on failure is "soft", the
// safe pre-launch state.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";

export type LaunchMode = "soft" | "hard";

// Public read of the current launch mode. Read on every page load, so a failure
// degrades to "soft" — the safe, nothing-leaks default.
export async function fetchLaunchMode(): Promise<LaunchMode> {
  try {
    // Bounded so a hung request can't strand the app on its loading splash.
    const res = await fetch("/api/launch-mode", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return "soft";
    const data = (await res.json()) as { mode?: unknown };
    return data.mode === "hard" ? "hard" : "soft";
  } catch {
    return "soft";
  }
}

type LaunchModeValue = {
  mode: LaunchMode;
  // True until the first /api/launch-mode resolves. The root layout holds first
  // paint on this so the flag is known before anything Ark+-aware renders.
  loading: boolean;
};

const LaunchModeContext = createContext<LaunchModeValue | null>(null);

export function LaunchModeProvider({ children }: { children: ReactNode }) {
  // Seed the safe "soft" state; `loading` gates first paint so we don't render
  // with this guess until the server value resolves.
  const [mode, setMode] = useState<LaunchMode>("soft");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetchLaunchMode().then((m) => {
      if (cancelled) return;
      setMode(m);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <LaunchModeContext.Provider value={{ mode, loading }}>
      {children}
    </LaunchModeContext.Provider>
  );
}

function useLaunchModeValue(): LaunchModeValue {
  const ctx = useContext(LaunchModeContext);
  if (!ctx) {
    throw new Error("useLaunchMode must be used inside <LaunchModeProvider>");
  }
  return ctx;
}

export function useLaunchMode(): LaunchMode {
  return useLaunchModeValue().mode;
}

// True until the launch mode is known. Used only by the root layout to gate
// first paint.
export function useLaunchModeLoading(): boolean {
  return useLaunchModeValue().loading;
}

export function useIsSoftLaunch(): boolean {
  return useLaunchModeValue().mode === "soft";
}

// Renders children only in hard launch. In soft launch the Ark+ membership
// surfaces don't exist, so a direct hit on one of those routes redirects to the
// soft-launch landing rather than 404-ing or flashing. Mirrors the in-component
// redirect pattern used by membership-gated routes (e.g. src/routes/setup.tsx).
export function HardLaunchOnly({
  children,
  redirectTo = "/inside-call-me-back",
}: {
  children: ReactNode;
  redirectTo?: string;
}) {
  const { mode, loading } = useLaunchModeValue();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && mode === "soft") {
      void navigate({ to: redirectTo });
    }
  }, [loading, mode, navigate, redirectTo]);
  return mode === "hard" ? <>{children}</> : null;
}

// Renders children only in soft launch.
export function SoftLaunchOnly({ children }: { children: ReactNode }) {
  return useIsSoftLaunch() ? <>{children}</> : null;
}
