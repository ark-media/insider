import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import { AdminBadge, AdminTag } from "../../components/admin/AdminList";
import {
  createPromo,
  deletePromo,
  downloadCancellationsCsv,
  fetchCancellations,
  listPromos,
  type CancellationFilter,
  type CancellationSummary,
  type Promo,
  type PromoDraft,
} from "../../lib/admin";
import {
  adminField,
  adminFieldLabel,
  adminPrimaryButton,
} from "../../lib/admin-styles";
import { formatCouponDiscount } from "../../lib/currency";
import { errMessage } from "../../lib/errMessage";
import { useCrudResource } from "../../lib/useCrudResource";
import {
  COUPON_SLOT_LABEL,
  COUPON_SLOTS,
  isCouponSlot,
  type CouponSlot,
} from "../../../shared/retention";
import {
  CANCELLATION_REASONS,
  OFFER_OUTCOMES,
  outcomeLabel,
  reasonLabel,
  retainedProductLabel,
  type OfferOutcome,
} from "../../../shared/cancellation";

export const Route = createFileRoute("/admin/cancellations")({
  component: CancellationsAdmin,
});

function CancellationsAdmin() {
  return (
    <AdminShell active="cancellations" title="Cancellations">
      <div className="flex flex-col gap-12">
        <RetentionOffers />
        <CancellationSurvey />
      </div>
    </AdminShell>
  );
}

// --- Retention offers ------------------------------------------------------

type OfferForm = {
  name: string;
  offerKind: CouponSlot;
  discountType: "percent" | "amount";
  percentOff: string;
  amountDollars: string;
  // A save is always temporary — a retention discount is never "forever".
  duration: "once" | "repeating";
  durationInMonths: string;
  plan: "" | "monthly" | "yearly";
  maxRedemptions: string;
  redeemBy: string;
};

function emptyOffer(): OfferForm {
  return {
    name: "",
    offerKind: "supporter_coupon",
    discountType: "percent",
    percentOff: "20",
    amountDollars: "",
    duration: "repeating",
    durationInMonths: "6",
    plan: "",
    maxRedemptions: "",
    redeemBy: "",
  };
}

function describeDiscount(p: Promo): string {
  const amount = formatCouponDiscount(p.percentOff, p.amountOffCents, p.currency);
  const dur =
    p.duration === "repeating"
      ? `for ${p.durationInMonths} mo`
      : "one billing period";
  return `${amount} · ${dur}`;
}

// The save this offer fills. An untagged coupon predates the slot selector and
// is never shown to a member, so name it plainly rather than leave it blank.
function slotLabel(kind: string | null): string {
  return isCouponSlot(kind)
    ? COUPON_SLOT_LABEL[kind]
    : "not shown — no slot set";
}

function planLabel(plan: string | null): string {
  if (plan === "monthly") return "monthly plan";
  if (plan === "yearly") return "annual plan";
  return "both plans";
}

function RetentionOffers() {
  const crud = useCrudResource<Promo, OfferForm>({
    load: () => listPromos().then((all) => all.filter((p) => p.retentionOffer)),
    emptyForm: emptyOffer,
  });
  const { form, setForm, saving, formError } = crud;
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);

    const draft: PromoDraft = {
      code: "",
      name: form.name.trim(),
      discountType: form.discountType,
      duration: form.duration,
      plan: form.plan,
      autoApply: false,
      retentionOffer: true,
      offerKind: form.offerKind,
    };
    if (form.discountType === "percent") {
      draft.percentOff = Number(form.percentOff);
    } else {
      draft.amountOffCents = Math.round(Number(form.amountDollars) * 100);
    }
    if (form.duration === "repeating") {
      draft.durationInMonths = Number(form.durationInMonths);
    }
    if (form.maxRedemptions.trim()) {
      draft.maxRedemptions = Number(form.maxRedemptions);
    }
    if (form.redeemBy.trim()) {
      draft.redeemBy = new Date(form.redeemBy).toISOString();
    }

    const ok = await crud.runSave(() => createPromo(draft));
    if (ok) {
      setNotice(`Created retention offer for ${planLabel(form.plan)}.`);
      setForm(emptyOffer());
    }
  };

  const remove = (p: Promo) => {
    if (!confirm(`Delete this retention offer? Members in the cancel flow will no longer see it.`)) {
      return;
    }
    void crud.runRemove(() => deletePromo(p.id));
  };

  return (
    <section aria-label="Retention offers">
      <h2 className="label text-cyan">Retention offers</h2>
      <p className="mt-2 max-w-2xl text-body-sm text-fg-muted">
        The discount a member is offered when they start to cancel. Target an
        Choose which card it fills and which plan it targets; when several
        offers match, the largest discount is shown. A save always runs for a set
        number of months — never in perpetuity — and a member can take one only
        once every 12 months.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-2">
        <form onSubmit={submit} className="space-y-5">
          <div>
            <label htmlFor="o-name" className={adminFieldLabel}>
              Name
            </label>
            <input
              id="o-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Stay & save"
              className={`mt-2 ${adminField}`}
            />
            <p className="mt-1 text-body-sm text-fg-muted">
              Optional internal label.
            </p>
          </div>

          <div>
            <label htmlFor="o-kind" className={adminFieldLabel}>
              Where it appears
            </label>
            <select
              id="o-kind"
              value={form.offerKind}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  offerKind: e.target.value as CouponSlot,
                }))
              }
              className={`mt-2 ${adminField}`}
            >
              {COUPON_SLOTS.map((k) => (
                <option key={k} value={k}>
                  {COUPON_SLOT_LABEL[k]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-body-sm text-fg-muted">
              Where in the cancel flow this discount is used. One coupon per slot
              applies — the largest matching discount wins. The debundle slot
              isn't a card: it's the intro rate a member lands on automatically
              after splitting the bundle, so its duration sets how long that rate
              lasts.
            </p>
          </div>

          <div>
            <label htmlFor="o-plan" className={adminFieldLabel}>
              Applies to plan
            </label>
            <select
              id="o-plan"
              value={form.plan}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  plan: e.target.value as OfferForm["plan"],
                }))
              }
              className={`mt-2 ${adminField}`}
            >
              <option value="">Both plans</option>
              <option value="monthly">Monthly only</option>
              <option value="yearly">Annual only</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="o-type" className={adminFieldLabel}>
                Discount type
              </label>
              <select
                id="o-type"
                value={form.discountType}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    discountType: e.target.value as "percent" | "amount",
                  }))
                }
                className={`mt-2 ${adminField}`}
              >
                <option value="percent">Percent off</option>
                <option value="amount">Amount off (USD)</option>
              </select>
            </div>
            <div>
              {form.discountType === "percent" ? (
                <>
                  <label htmlFor="o-pct" className={adminFieldLabel}>
                    Percent off
                  </label>
                  <input
                    id="o-pct"
                    type="number"
                    required
                    min="1"
                    max="100"
                    value={form.percentOff}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, percentOff: e.target.value }))
                    }
                    className={`mt-2 ${adminField}`}
                  />
                </>
              ) : (
                <>
                  <label htmlFor="o-amt" className={adminFieldLabel}>
                    Amount off ($)
                  </label>
                  <input
                    id="o-amt"
                    type="number"
                    required
                    min="0"
                    step="0.01"
                    value={form.amountDollars}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, amountDollars: e.target.value }))
                    }
                    placeholder="5.00"
                    className={`mt-2 ${adminField}`}
                  />
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="o-dur" className={adminFieldLabel}>
                Duration
              </label>
              <select
                id="o-dur"
                value={form.duration}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    duration: e.target.value as OfferForm["duration"],
                  }))
                }
                className={`mt-2 ${adminField}`}
              >
                <option value="repeating">For a set number of months</option>
                <option value="once">One billing period</option>
              </select>
            </div>
            {form.duration === "repeating" ? (
              <div>
                <label htmlFor="o-months" className={adminFieldLabel}>
                  Months
                </label>
                <input
                  id="o-months"
                  type="number"
                  required
                  min="1"
                  value={form.durationInMonths}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, durationInMonths: e.target.value }))
                  }
                  className={`mt-2 ${adminField}`}
                />
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="o-max" className={adminFieldLabel}>
                Max redemptions
              </label>
              <input
                id="o-max"
                type="number"
                min="1"
                value={form.maxRedemptions}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxRedemptions: e.target.value }))
                }
                placeholder="Unlimited"
                className={`mt-2 ${adminField}`}
              />
            </div>
            <div>
              <label htmlFor="o-expiry" className={adminFieldLabel}>
                Expires
              </label>
              <input
                id="o-expiry"
                type="datetime-local"
                value={form.redeemBy}
                onChange={(e) =>
                  setForm((f) => ({ ...f, redeemBy: e.target.value }))
                }
                className={`mt-2 ${adminField}`}
              />
            </div>
          </div>

          {formError ? (
            <p className="text-body-sm text-red-400">{formError}</p>
          ) : null}
          {notice ? <p className="text-body-sm text-cyan">{notice}</p> : null}

          <button type="submit" disabled={saving} className={adminPrimaryButton}>
            {saving ? "Creating…" : "Create offer"}
          </button>
        </form>

        <div aria-label="Existing retention offers">
          <h3 className="font-display text-lg text-fg-strong">Active offers</h3>
          {crud.loading ? (
            <p className="mt-6 text-body-sm">Loading…</p>
          ) : crud.listError ? (
            <p className="mt-6 text-body-sm text-red-400">{crud.listError}</p>
          ) : crud.items.length === 0 ? (
            <p className="mt-6 text-body-sm text-fg-muted">
              No retention offers yet — members who cancel see no discount.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {crud.items.map((p) => (
                <li key={p.id} className="border border-rule p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-body-lg font-display text-fg-strong">
                      {p.name ?? p.id}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(p)}
                      className="button-text font-bold text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                  <p className="mt-1 text-body-sm text-fg">
                    {describeDiscount(p)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 label font-bold">
                    <AdminTag>{slotLabel(p.offerKind)}</AdminTag>
                    <AdminTag>{planLabel(p.plan)}</AdminTag>
                    <AdminBadge on={p.valid} label={p.valid ? "valid" : "expired"} />
                    {p.maxRedemptions != null ? (
                      <AdminTag>
                        {p.timesRedeemed}/{p.maxRedemptions} used
                      </AdminTag>
                    ) : null}
                    {p.redeemBy ? (
                      <AdminTag>
                        expires {new Date(p.redeemBy).toLocaleDateString()}
                      </AdminTag>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

// --- Cancellation survey ---------------------------------------------------

function CancellationSurvey() {
  const [data, setData] = useState<CancellationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Retry button to re-run the current filter.
  const [reloadNonce, setReloadNonce] = useState(0);

  const [outcome, setOutcome] = useState<OfferOutcome | "">("");
  const [reason, setReason] = useState<string>("");

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Memoized so refresh() only re-runs when a filter actually changes.
  const filter: CancellationFilter = useMemo(
    () => ({ outcome: outcome || null, reason: reason || null }),
    [outcome, reason],
  );

  const refresh = useCallback(() => setReloadNonce((n) => n + 1), []);

  // The fetch this render wants. `loading` is derived: it stays true until a
  // response for exactly this request lands, so a filter change or a retry
  // shows the spinner without the effect having to set state synchronously.
  const request = useMemo(() => ({ filter, reloadNonce }), [filter, reloadNonce]);
  const [loaded, setLoaded] = useState<typeof request | null>(null);
  const loading = loaded !== request;

  useEffect(() => {
    let live = true;
    fetchCancellations(request.filter).then(
      (next) => {
        if (!live) return;
        setData(next);
        setError(null);
        setLoaded(request);
      },
      (err: unknown) => {
        if (!live) return;
        setError(errMessage(err, "Failed to load."));
        setLoaded(request);
      },
    );
    return () => {
      live = false;
    };
  }, [request]);

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadCancellationsCsv(filter);
    } catch (err) {
      setExportError(errMessage(err, "Export failed."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section aria-label="Cancellation survey">
      <h2 className="label text-cyan">Survey</h2>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="c-outcome" className={adminFieldLabel}>
            Outcome
          </label>
          <select
            id="c-outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as OfferOutcome | "")}
            className={`mt-2 ${adminField}`}
          >
            <option value="">All outcomes</option>
            {OFFER_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {outcomeLabel(o)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="c-reason" className={adminFieldLabel}>
            Reason
          </label>
          <select
            id="c-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`mt-2 ${adminField}`}
          >
            <option value="">All reasons</option>
            {CANCELLATION_REASONS.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting}
          className={adminPrimaryButton}
        >
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>
      <p className="mt-2 text-body-sm text-fg-muted">
        Filters apply to the responses below and the CSV export. The outcome and
        reason totals above stay across all responses.
      </p>
      {exportError ? (
        <p className="mt-2 text-body-sm text-danger">{exportError}</p>
      ) : null}

      {loading ? (
        <p className="mt-6 text-fg-muted">Loading…</p>
      ) : error ? (
        <div className="mt-6">
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
        <div className="mt-6 flex flex-col gap-10">
          <CancellationsBody data={data} filtered={Boolean(outcome || reason)} />
        </div>
      ) : null}
    </section>
  );
}

function CancellationsBody({
  data,
  filtered,
}: {
  data: CancellationSummary;
  filtered: boolean;
}) {
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
        <h3 className="font-display text-lg text-fg-strong">Outcomes</h3>
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
        <h3 className="font-display text-lg text-fg-strong">Reasons</h3>
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
        <h3 className="font-display text-lg text-fg-strong">Recent responses</h3>
        {data.recent.length === 0 ? (
          <p className="mt-4 text-body-sm text-fg-muted">
            {filtered ? "No responses match these filters." : "No responses yet."}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-rule text-left text-fg-muted">
                  <th className="py-2 pr-4 font-normal">Date</th>
                  <th className="py-2 pr-4 font-normal">Email</th>
                  <th className="py-2 pr-4 font-normal">Outcome</th>
                  <th className="py-2 pr-4 font-normal">Type</th>
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
                    {/* Distinguishes a debundle (kept one product) from a full
                        cancel or an accept, with the tier the member left. */}
                    <td className="py-2 pr-4 text-fg">
                      {row.retainedProduct ? (
                        <span>
                          {retainedProductLabel(row.retainedProduct)}
                          {row.canceledTier ? (
                            <span className="text-fg-muted">
                              {" "}
                              (from {row.canceledTier})
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-4 text-fg">
                      {row.reasons.length > 0
                        ? row.reasons
                            .map((slug) => reasonLabel(slug) ?? slug)
                            .join("; ")
                        : "—"}
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
