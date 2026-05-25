import { type ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { StatusPage, HomeButton } from "./StatusPage";

// Client-side gate for the back office. This is UX only — every admin API
// endpoint independently re-verifies the Auth0 "admin" role server-side, so a
// crafted client can't reach the data by bypassing this.
export function AdminGuard({ children }: { children: ReactNode }) {
  const { isAdmin, adminLoading } = useSubscriberAuth();
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();

  if (isLoading || adminLoading) {
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

  if (!isAuthenticated) {
    return (
      <StatusPage
        eyebrow="Admin"
        title="Sign in required"
        message="You need to sign in with an admin account to access the back office."
        actions={
          <>
            <button
              type="button"
              onClick={() => void loginWithRedirect()}
              className="inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
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
