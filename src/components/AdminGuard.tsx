import { type ReactNode } from "react";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { StatusPage, HomeButton } from "./StatusPage";

// Client-side gate for the back office. This is UX only — every admin API
// endpoint independently re-verifies the "admin" role server-side, so a
// crafted client can't reach the data by bypassing this.
export function AdminGuard({ children }: { children: ReactNode }) {
  const { state, isAdmin, adminLoading, signIn } = useSubscriberAuth();

  if (state.kind === "loading" || adminLoading) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-[1100px] flex-col items-center justify-center px-6 py-16">
        <div
          role="status"
          aria-label="Loading"
          className="h-6 w-6 animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none"
        />
      </div>
    );
  }

  if (state.kind !== "member") {
    return (
      <StatusPage
        eyebrow="Admin"
        title="Sign in required"
        message="You need to sign in with an admin account to access the back office."
        actions={
          <>
            <button
              type="button"
              onClick={() => signIn("/admin")}
              className="inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Sign in
            </button>
            <HomeButton />
          </>
        }
      />
    );
  }

  if (!isAdmin) {
    return (
      <StatusPage
        eyebrow="Admin"
        title="Not authorized"
        message="Your account doesn't have admin access. Ask an existing admin to grant it, then sign out and back in."
      />
    );
  }

  return <>{children}</>;
}
