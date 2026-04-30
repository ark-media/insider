import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { fetchMe, cancelSubscription } from "../../lib/auth";
import { PageShell } from "../../components/PageShell";

export const Route = createFileRoute("/account/billing")({
  beforeLoad: async () => {
    const me = await fetchMe();
    if (!me) throw redirect({ to: "/plus" });
    return { me };
  },
  component: BillingPage,
});

function BillingPage() {
  const { me } = Route.useRouteContext();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "cancelling" }
    | { kind: "ok"; until: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const onCancel = async () => {
    if (
      !window.confirm(
        "Cancel your Ark+ membership? You'll keep access until the end of your current billing period.",
      )
    ) {
      return;
    }
    setStatus({ kind: "cancelling" });
    const r = await cancelSubscription();
    if (r.ok) {
      setStatus({ kind: "ok", until: r.access_until ?? "" });
    } else {
      setStatus({
        kind: "error",
        message: r.error ?? "Could not cancel — please try again.",
      });
    }
  };

  return (
    <PageShell
      eyebrow="Billing"
      title="Your Ark+ membership."
      lede={`Signed in as ${me.email}.`}
    >
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="border border-white/12 bg-navy-800/40 p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Manage payment & invoices
              </div>
              <p className="mt-4 max-w-md text-[14px] leading-[1.6] text-white/70">
                Update your card, change your billing email, or download
                invoices in the Stripe Customer Portal.
              </p>
              <button
                type="button"
                disabled
                className="mt-6 inline-flex items-center gap-2 border border-white/25 px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white/55 opacity-60"
              >
                Open Stripe portal →
              </button>
              <p className="mt-3 text-[11px] leading-snug text-white/45">
                Stripe portal redirect not yet wired in this preview build.
              </p>
            </div>

            <div className="border border-white/12 bg-navy-800/40 p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Cancel
              </div>
              <p className="mt-4 max-w-md text-[14px] leading-[1.6] text-white/70">
                Cancel anytime. You'll keep access through the end of your
                current billing period.
              </p>
              {status.kind === "ok" ? (
                <p className="mt-6 text-[13px] text-cyan" aria-live="polite">
                  Cancellation confirmed.{" "}
                  {status.until
                    ? `Access continues until ${new Date(status.until).toLocaleDateString()}.`
                    : ""}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={status.kind === "cancelling"}
                  className="mt-6 inline-flex items-center gap-2 border border-white/25 px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white transition hover:border-signal hover:text-signal disabled:opacity-60"
                >
                  {status.kind === "cancelling"
                    ? "Cancelling…"
                    : "Cancel my membership"}
                </button>
              )}
              {status.kind === "error" ? (
                <p
                  className="mt-3 text-[12px] text-signal/80"
                  aria-live="polite"
                >
                  {status.message}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
