import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { cancelSubscription } from "../../lib/auth";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { Modal } from "../../components/Modal";

export const Route = createFileRoute("/account/billing")({
  component: BillingPage,
});

function BillingPage() {
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "cancelling" }
    | { kind: "ok"; until: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
      return;
    }
    if (state.kind === "member" && state.me.tier !== "subscriber") {
      void navigate({ to: "/plus" });
    }
  }, [state, navigate]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest" || state.me.tier !== "subscriber") return null;

  const me = state.me;

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
      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="border border-rule bg-navy-800/40 p-8">
              <h2 className="label text-cyan">
                Manage payment & invoices
              </h2>
              <p className="mt-4 max-w-md text-body-sm text-fg">
                Update your card, change your billing email, or download
                invoices in the Stripe Customer Portal.
              </p>
              <button
                type="button"
                disabled
                className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-muted opacity-60"
              >
                Open Stripe portal →
              </button>
              <p className="mt-3 text-body-sm">
                Stripe portal redirect not yet wired in this preview build.
              </p>
            </div>

            <div className="border border-rule bg-navy-800/40 p-8">
              <h2 className="label text-cyan">
                Cancel
              </h2>
              <p className="mt-4 max-w-md text-body-sm text-fg">
                Cancel anytime. You'll keep access through the end of your
                current billing period.
              </p>
              {status.kind === "ok" ? (
                <p className="mt-6 text-body-sm text-cyan" aria-live="polite">
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
                  className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                >
                  {status.kind === "cancelling"
                    ? "Cancelling…"
                    : "Cancel my membership"}
                </button>
              )}
              {status.kind === "error" ? (
                <p
                  className="mt-3 text-body-sm text-danger"
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
        <p className="mt-4 text-body-sm text-fg">
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
