import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import {
  AdminBadge,
  AdminListPanel,
  AdminTag,
} from "../../components/admin/AdminList";
import {
  createPromo,
  deletePromo,
  listPromos,
  type Promo,
  type PromoDraft,
} from "../../lib/admin";
import {
  adminField,
  adminFieldLabel,
  adminPrimaryButton,
} from "../../lib/admin-styles";
import { formatCouponDiscount } from "../../lib/currency";
import { useCrudResource } from "../../lib/useCrudResource";
import { formatTimestamp } from "../../../shared/format-date";

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
  const crud = useCrudResource<Promo, FormState>({
    load: listPromos,
    emptyForm,
  });
  const { form, setForm, saving, formError } = crud;
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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

    const ok = await crud.runSave(async () => {
      const promo = await createPromo(draft);
      setNotice(
        `Created ${promo.code ? `code ${promo.code}` : promo.id}${
          promo.autoApply ? " — auto-applies at checkout." : "."
        }`,
      );
    });
    if (ok) setForm(emptyForm());
  };

  const remove = (p: Promo) => {
    if (!confirm(`Delete coupon ${p.code ?? p.id}? This invalidates its code.`)) {
      return;
    }
    void crud.runRemove(() => deletePromo(p.id));
  };

  // Retention save offers are managed on the Cancellations page; keep this list
  // to the checkout coupons it's about.
  const checkoutPromos = crud.items.filter((p) => !p.retentionOffer);

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

            <button type="submit" disabled={saving} className={adminPrimaryButton}>
              {saving ? "Creating…" : "Create promo"}
            </button>
          </form>
        </section>

        <AdminListPanel
          title="All promos"
          ariaLabel="Existing promos"
          loading={crud.loading}
          error={crud.listError}
          items={checkoutPromos}
          emptyText="No coupons in Stripe yet."
          renderItem={(p) => (
            <li key={p.id} className="border border-rule p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-body-lg font-display text-fg-strong">
                  {p.code ?? p.name ?? p.id}
                </span>
                <button
                  type="button"
                  onClick={() => remove(p)}
                  className="button-text font-bold text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
              <p className="mt-1 text-body-sm text-fg">{describeDiscount(p)}</p>
              <div className="mt-2 flex flex-wrap gap-2 label font-bold">
                <AdminBadge
                  on={p.autoApply}
                  label={p.autoApply ? "auto-apply" : "code only"}
                />
                <AdminBadge on={p.valid} label={p.valid ? "valid" : "expired"} />
                {p.plan ? <AdminTag>{p.plan}</AdminTag> : <AdminTag>both plans</AdminTag>}
                {p.maxRedemptions != null ? (
                  <AdminTag>
                    {p.timesRedeemed}/{p.maxRedemptions} used
                  </AdminTag>
                ) : null}
                {p.redeemBy ? (
                  <AdminTag>
                    expires {formatTimestamp(p.redeemBy)}
                  </AdminTag>
                ) : null}
              </div>
            </li>
          )}
        />
      </div>
    </AdminShell>
  );
}
