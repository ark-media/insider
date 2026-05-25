import { type ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useSubscriberAuth } from "../lib/subscriberAuth";

// Client-side gate for the back office. This is UX only — every admin API
// endpoint independently re-verifies the Auth0 "admin" role server-side, so a
// crafted client can't reach the data by bypassing this.
export function AdminGuard({ children }: { children: ReactNode }) {
  const { isAdmin, adminLoading } = useSubscriberAuth();
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();

  if (isLoading || adminLoading) {
    return (
      <Centered>
        <div
          role="status"
          aria-label="Loading"
          className="h-6 w-6 animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none"
        />
      </Centered>
    );
  }

  if (!isAuthenticated) {
    return (
      <Centered>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-3 font-display text-2xl text-fg-strong">Sign in required</h1>
        <p className="mt-2 max-w-sm text-[14px] text-fg-muted">
          You need to sign in with an admin account to access the back office.
        </p>
        <button
          type="button"
          onClick={() => void loginWithRedirect()}
          className="mt-6 inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-4 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Sign in
        </button>
      </Centered>
    );
  }

  if (!isAdmin) {
    return (
      <Centered>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-3 font-display text-2xl text-fg-strong">Not authorized</h1>
        <p className="mt-2 max-w-sm text-[14px] text-fg-muted">
          Your account doesn't have admin access. Ask an existing admin to grant
          it, then sign out and back in.
        </p>
      </Centered>
    );
  }

  return <>{children}</>;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[1100px] flex-col items-center justify-center px-6 py-16 text-center">
      {children}
    </div>
  );
}
