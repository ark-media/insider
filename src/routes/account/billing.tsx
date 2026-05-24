import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { fetchMe, cancelSubscription } from "../../lib/auth";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { Modal } from "../../components/Modal";

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
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onCancel = async () => {
    setConfirmOpen(false);
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
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Account", to: "/account" },
            { label: "Billing" },
          ]}
        />
      }
      eyebrow="Billing"
      title="Your Ark+ membership."
      lede={`Signed in as ${me.email}.`}
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="border border-rule bg-navy-800/40 p-8">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Manage payment & invoices
              </h2>
              <p className="mt-4 max-w-md text-[14px] leading-[1.6] text-fg">
                Update your card, change your billing email, or download
                invoices in the Stripe Customer Portal.
              </p>
              <button
                type="button"
                disabled
                className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-fg-muted opacity-60"
              >
                Open Stripe portal →
              </button>
              <p className="mt-3 text-[11px] leading-snug text-fg-muted">
                Stripe portal redirect not yet wired in this preview build.
              </p>
            </div>

            <div className="border border-rule bg-navy-800/40 p-8">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Cancel
              </h2>
              <p className="mt-4 max-w-md text-[14px] leading-[1.6] text-fg">
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
                  onClick={() => setConfirmOpen(true)}
                  disabled={status.kind === "cancelling"}
                  className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-fg-strong transition hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                >
                  {status.kind === "cancelling"
                    ? "Cancelling…"
                    : "Cancel my membership"}
                </button>
              )}
              {status.kind === "error" ? (
                <p
                  className="mt-3 text-[12px] text-danger"
                  aria-live="polite"
                >
                  {status.message}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        className="max-w-md"
        labelledBy="cancel-title"
        describedBy="cancel-desc"
      >
        <p id="cancel-desc" className="eyebrow">
          Cancel membership
        </p>
        <h2
          id="cancel-title"
          className="display-upright mt-3 text-[clamp(1.5rem,3vw,1.9rem)] leading-[1.05] text-fg-strong"
        >
          Cancel your Ark+ membership?
        </h2>
        <p className="mt-4 text-[14px] leading-[1.6] text-fg">
          You'll keep access until the end of your current billing period.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-12 flex-1 items-center justify-center border border-danger px-4 text-sm font-semibold uppercase tracking-button text-danger transition hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Yes, cancel
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(false)}
            className="inline-flex min-h-12 flex-1 items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Never mind
          </button>
        </div>
      </Modal>
    </PageShell>
  );
}
