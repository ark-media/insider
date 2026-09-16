import { useState } from "react";
import { contactEmails } from "../config/urls";

// The BFF callback redirects to `/?auth_error=<code>` when sign-in fails
// (server/routes/auth.ts). Surface a readable message instead of silently
// dropping the user on the homepage with a mystery query param.
const MESSAGES: Record<string, string> = {
  expired: "Your sign-in session expired. Please try signing in again.",
  exchange: "Sign-in didn't complete. Please try again.",
  profile: "We couldn't verify your account. Please try again.",
  // `denied` is permanent (Auth0 rejected the account), so don't tell the user
  // to "try again" — point them at support instead.
  denied: `This account isn't authorized to sign in to Ark+. If you think this is a mistake, contact ${contactEmails.support}.`,
};

export function AuthErrorNotice() {
  // Read once on mount and strip the param so a refresh doesn't re-show it.
  const [code] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const c = new URLSearchParams(window.location.search).get("auth_error");
    if (c) {
      const url = new URL(window.location.href);
      url.searchParams.delete("auth_error");
      window.history.replaceState(
        {},
        document.title,
        url.pathname + url.search + url.hash,
      );
    }
    return c;
  });
  const [dismissed, setDismissed] = useState(false);

  const message = code ? (MESSAGES[code] ?? MESSAGES.exchange) : null;
  if (!message || dismissed) return null;

  return (
    <div
      role="alert"
      className="border-b border-danger/40 bg-danger/10 px-6 py-3 text-center text-[13px] text-danger"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-3 font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        ×
      </button>
    </div>
  );
}
