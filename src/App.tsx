import { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { Gift } from "./pages/Gift";
import { SetupFlow } from "./components/SetupFlow";
import { fetchMe, type Me } from "./lib/auth";

type AuthState =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "member"; me: Me };

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // If a guest lands on #setup, bounce them back to home. Done in an effect
  // so we never mutate location during render.
  useEffect(() => {
    if (hash === "#setup" && auth.kind === "guest") {
      window.location.hash = "";
    }
  }, [hash, auth.kind]);

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((me) => {
      if (cancelled) return;
      setAuth(me ? { kind: "member", me } : { kind: "guest" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (hash === "#setup") {
    if (auth.kind === "loading") {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-navy-900 text-sm text-white/60">
          Loading…
        </div>
      );
    }
    if (auth.kind === "guest") {
      return <Home authed={false} />;
    }
    return <SetupFlow me={auth.me} />;
  }

  if (hash === "#gifts") {
    return (
      <Gift authed={auth.kind === "loading" ? undefined : auth.kind === "member"} />
    );
  }

  return (
    <Home authed={auth.kind === "loading" ? undefined : auth.kind === "member"} />
  );
}
