import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import {
  createPromo,
  deletePromo,
  listPromos,
  type Promo,
  type PromoDraft,
} from "../../lib/admin";
import { adminField, adminFieldLabel } from "../../lib/admin-styles";
import { formatCouponDiscount } from "../../lib/currency";

export const Route = createFileRoute("/admin/promos")({
  component: PromosAdmin,
});

type FormState = {
  code: string;
  name: string;
  discountType: "percent" | "amount";
  percentOff: string;
  amountDollars: string;
  duration: "once" | "forever" | "repeating";
  durationInMonths: string;
  plan: "" | "monthly" | "yearly";
  autoApply: boolean;
  maxRedemptions: string;
  redeemBy: string;
};

function emptyForm(): FormState {
  return {
    code: "",
    name: "",
    discountType: "percent",
    percentOff: "20",
    amountDollars: "",
    duration: "once",
    durationInMonths: "",
    plan: "",
    autoApply: false,
    maxRedemptions: "",
    redeemBy: "",
  };
}

function describeDiscount(p: Promo): string {
  const amount = formatCouponDiscount(p.percentOff, p.amountOffCents, p.currency);
  const dur =
    p.duration === "repeating"
      ? `for ${p.durationInMonths} mo`
      : p.duration === "forever"
        ? "forever"
        : "once";
  return `${amount} · ${dur}`;
}

function PromosAdmin() {
  const [items, setItems] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listPromos());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    setNotice(null);

    const draft: PromoDraft = {
      code: form.code.trim(),
      name: form.name.trim(),
      discountType: form.discountType,
      duration: form.duration,
      plan: form.plan,
      autoApply: form.autoApply,
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

    try {
      const promo = await createPromo(draft);
      setNotice(
        `Created ${promo.code ? `code ${promo.code}` : promo.id}${
          promo.autoApply ? " — auto-applies at checkout." : "."
        }`,
      );
      setForm(emptyForm());
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Promo) => {
    if (!confirm(`Delete coupon ${p.code ?? p.id}? This invalidates its code.`)) {
      return;
    }
    try {
      await deletePromo(p.id);
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to delete.");
    }
  };

  // Retention save offers are managed on the Cancellations page; keep this list
  // to the checkout coupons it's about.
  const checkoutPromos = items.filter((p) => !p.retentionOffer);

  return (
    <AdminShell active="promos" title="Promo codes">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <section aria-label="New promo code">
          <h2 className="font-display text-lg text-fg-strong">New promo</h2>
          <p className="mt-2 text-body-sm">
            Creates a Stripe coupon (and a promotion code if you set one). Promos
            marked <strong className="text-fg">auto-apply</strong> discount the
            targeted plan at checkout automatically.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="p-code" className={adminFieldLabel}>
                  Code
                </label>
                <input
                  id="p-code"
                  type="text"
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="SPRING60"
                  className={`mt-2 ${adminField}`}
                />
                <p className="mt-1 text-body-sm">Optional label code.</p>
              </div>
              <div>
                <label htmlFor="p-name" className={adminFieldLabel}>
                  Name
                </label>
                <input
                  id="p-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Spring sale"
                  className={`mt-2 ${adminField}`}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="p-type" className={adminFieldLabel}>
                  Discount type
                </label>
                <select
                  id="p-type"
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
                    <label htmlFor="p-pct" className={adminFieldLabel}>
                      Percent off
                    </label>
                    <input
                      id="p-pct"
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
                    <label htmlFor="p-amt" className={adminFieldLabel}>
                      Amount off ($)
                    </label>
                    <input
                      id="p-amt"
                      type="number"
                      required
                      min="0"
                      step="0.01"
                      value={form.amountDollars}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, amountDollars: e.target.value }))
                      }
                      placeholder="10.00"
                      className={`mt-2 ${adminField}`}
                    />
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="p-dur" className={adminFieldLabel}>
                  Duration
                </label>
                <select
                  id="p-dur"
                  value={form.duration}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      duration: e.target.value as FormState["duration"],
                    }))
                  }
                  className={`mt-2 ${adminField}`}
                >
                  <option value="once">Once</option>
                  <option value="forever">Forever</option>
                  <option value="repeating">Repeating</option>
                </select>
              </div>
              {form.duration === "repeating" ? (
                <div>
                  <label htmlFor="p-months" className={adminFieldLabel}>
                    Months
                  </label>
                  <input
                    id="p-months"
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

            <div>
              <label htmlFor="p-plan" className={adminFieldLabel}>
                Applies to plan
              </label>
              <select
                id="p-plan"
                value={form.plan}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    plan: e.target.value as FormState["plan"],
                  }))
                }
                className={`mt-2 ${adminField}`}
              >
                <option value="">Both plans</option>
                <option value="monthly">Monthly only</option>
                <option value="yearly">Yearly only</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="p-max" className={adminFieldLabel}>
                  Max redemptions
                </label>
                <input
                  id="p-max"
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
                <label htmlFor="p-expiry" className={adminFieldLabel}>
                  Expires
                </label>
                <input
                  id="p-expiry"
                  type="datetime-local"
                  value={form.redeemBy}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, redeemBy: e.target.value }))
                  }
                  className={`mt-2 ${adminField}`}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-body-sm text-fg">
              <input
                type="checkbox"
                checked={form.autoApply}
                onChange={(e) =>
                  setForm((f) => ({ ...f, autoApply: e.target.checked }))
                }
                className="size-4 accent-cyan"
              />
              Auto-apply at checkout (no code needed)
            </label>

            {formError ? <p className="text-body-sm text-red-400">{formError}</p> : null}
            {notice ? <p className="text-body-sm text-cyan">{notice}</p> : null}

            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
            >
              {saving ? "Creating…" : "Create promo"}
            </button>
          </form>
        </section>

        <section aria-label="Existing promos">
          <h2 className="font-display text-lg text-fg-strong">All promos</h2>
          {loading ? (
            <p className="mt-6 text-body-sm">Loading…</p>
          ) : listError ? (
            <p className="mt-6 text-body-sm text-red-400">{listError}</p>
          ) : checkoutPromos.length === 0 ? (
            <p className="mt-6 text-body-sm">No coupons in Stripe yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {checkoutPromos.map((p) => (
                <li key={p.id} className="border border-rule p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-body-lg font-display text-fg-strong">
                      {p.code ?? p.name ?? p.id}
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(p)}
                      className="button-text font-bold text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                  <p className="mt-1 text-body-sm text-fg">{describeDiscount(p)}</p>
                  <div className="mt-2 flex flex-wrap gap-2 label font-bold">
                    <Badge on={p.autoApply} label={p.autoApply ? "auto-apply" : "code only"} />
                    <Badge on={p.valid} label={p.valid ? "valid" : "expired"} />
                    {p.plan ? <Tag>{p.plan}</Tag> : <Tag>both plans</Tag>}
                    {p.maxRedemptions != null ? (
                      <Tag>
                        {p.timesRedeemed}/{p.maxRedemptions} used
                      </Tag>
                    ) : null}
                    {p.redeemBy ? (
                      <Tag>expires {new Date(p.redeemBy).toLocaleDateString()}</Tag>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

function Badge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 ${
        on ? "border-cyan/60 text-cyan" : "border-rule-strong text-fg-muted"
      }`}
    >
      {label}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center border border-rule-strong px-2 py-0.5 text-fg-muted">
      {children}
    </span>
  );
}
