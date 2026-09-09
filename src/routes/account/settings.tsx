import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { requestPasswordReset } from "../../lib/profile";
import { EmailPreferences } from "../../components/account/EmailPreferences";
import { ProfileNameCard } from "../../components/account/ProfileNameCard";

export const Route = createFileRoute("/account/settings")({
  component: SettingsTab,
});

// The Settings tab: the two things a member comes here to change that aren't
// their membership — what we email them, and who we think they are.
//
// This replaces /account/newsletters, which was a page of its own for a single
// toggle.
function SettingsTab() {
  const { state, refresh, signOut } = useSubscriberAuth();
  if (state.kind !== "member") return null;
  const { me } = state;

  return (
    <section>
      <div className="page-section max-w-3xl">
        <h2 className="text-h2">Settings</h2>

        <div className="mt-10">
          <EmailPreferences email={me.email} />
        </div>

        <div className="mt-12">
          <h3 className="label text-cyan">Profile &amp; sign-in</h3>
          <div className="mt-4 divide-y divide-rule border border-rule bg-navy-800/40">
            <ProfileNameCard onSaved={refresh} rowClassName="p-6" />

            {/* Read-only on purpose. The address is the Auth0 identity, the
                Stripe customer, and the Beehiiv subscriber all at once, so
                changing it here would silently mean changing it in three
                systems — support does it deliberately instead. */}
            <div className="p-6">
              <div className="eyebrow text-fg-muted">Email</div>
              <p className="mt-2 text-body text-fg-strong">{me.email}</p>
            </div>

            {/* Only for accounts that have a password at all — a member who
                signs in with Google has nothing here to reset. */}
            {me.passwordResettable ? <PasswordRow /> : null}
          </div>

          <button
            type="button"
            onClick={signOut}
            className="mt-6 inline-flex min-h-12 w-full items-center justify-center border border-rule-strong px-6 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:w-auto"
          >
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}

function PasswordRow() {
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const send = async () => {
    setStatus({ kind: "sending" });
    const result = await requestPasswordReset();
    setStatus(
      result.ok ? { kind: "sent" } : { kind: "error", message: result.error },
    );
  };

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="eyebrow text-fg-muted">Password</div>
          <p className="mt-2 text-body text-fg-strong" aria-hidden="true">
            ••••••••
          </p>
        </div>
        {status.kind === "sent" ? null : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={status.kind === "sending"}
            className="text-body-sm text-cyan underline underline-offset-4 transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
          >
            {status.kind === "sending" ? "Sending…" : "Send a reset link"}
          </button>
        )}
      </div>
      {status.kind === "sent" ? (
        <p className="mt-2 text-body-sm text-cyan" aria-live="polite">
          Check your inbox — we've emailed you a link to set a new password.
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className="mt-2 text-body-sm text-danger" role="alert">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
