import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import { fetchCancellations, type CancellationSummary } from "../../lib/admin";
import { reasonLabel } from "../../../shared/cancellation";

export const Route = createFileRoute("/admin/cancellations")({
  component: CancellationsAdmin,
});

// Friendly labels for the stored offer_outcome values.
const OUTCOME_LABEL: Record<string, string> = {
  accepted: "Kept (offer accepted)",
  declined: "Cancelled (offer declined)",
  not_offered: "Cancelled (no offer)",
};

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

function CancellationsAdmin() {
  const [data, setData] = useState<CancellationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchCancellations());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AdminShell active="cancellations" title="Cancellations">
      {loading ? (
        <p className="text-fg-muted">Loading…</p>
      ) : error ? (
        <div>
          <p className="text-body-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 inline-flex min-h-10 items-center border border-rule-strong px-4 button-text font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Retry
          </button>
        </div>
      ) : data ? (
        <div className="flex flex-col gap-10">
          <CancellationsBody data={data} />
        </div>
      ) : null}
    </AdminShell>
  );
}

function CancellationsBody({ data }: { data: CancellationSummary }) {
  const isEmpty =
    data.byOutcome.length === 0 &&
    data.byReason.length === 0 &&
    data.recent.length === 0;

  if (isEmpty) {
    return (
      <p className="text-body-sm text-fg-muted">
        No cancellation survey responses yet.
      </p>
    );
  }

  return (
    <>
      <section>
        <h2 className="label text-cyan">Outcomes</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {data.byOutcome.map((o) => (
            <div key={o.outcome} className="border border-rule p-5">
              <p className="font-display text-3xl text-fg-strong">{o.count}</p>
              <p className="mt-1 text-body-sm text-fg-muted">
                {outcomeLabel(o.outcome)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="label text-cyan">Reasons</h2>
        {data.byReason.length === 0 ? (
          <p className="mt-4 text-body-sm text-fg-muted">
            No reasons recorded yet.
          </p>
        ) : (
          <table className="mt-4 w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-rule text-left text-fg-muted">
                <th className="py-2 pr-4 font-normal">Reason</th>
                <th className="py-2 font-normal">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.byReason.map((r) => (
                <tr key={r.reason} className="border-b border-rule/50">
                  <td className="py-2 pr-4 text-fg">{reasonLabel(r.reason)}</td>
                  <td className="py-2 text-fg-strong">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="label text-cyan">Recent responses</h2>
        {data.recent.length === 0 ? (
          <p className="mt-4 text-body-sm text-fg-muted">No responses yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-rule text-left text-fg-muted">
                  <th className="py-2 pr-4 font-normal">Date</th>
                  <th className="py-2 pr-4 font-normal">Email</th>
                  <th className="py-2 pr-4 font-normal">Outcome</th>
                  <th className="py-2 pr-4 font-normal">Reason</th>
                  <th className="py-2 font-normal">Note</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((row, i) => (
                  <tr key={i} className="border-b border-rule/50 align-top">
                    <td className="py-2 pr-4 whitespace-nowrap text-fg-muted">
                      {new Date(row.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 text-fg">{row.email}</td>
                    <td className="py-2 pr-4 text-fg">
                      {outcomeLabel(row.offerOutcome)}
                    </td>
                    <td className="py-2 pr-4 text-fg">
                      {reasonLabel(row.reason) ?? "—"}
                    </td>
                    <td className="py-2 text-fg-muted">{row.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
