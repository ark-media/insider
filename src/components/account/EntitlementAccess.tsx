import { useState } from "react";
import type { AxisAccess, Me } from "../../lib/auth";
import { changeTier, getMySubscription } from "../../lib/auth";
import { formatTimestamp } from "../../../shared/format-date";
import { CheckoutModal } from "../CheckoutModal";
import { HeadphonesIcon, ChatIcon } from "./SurfaceIcons";

// Per-axis entitlement rows for account settings (T7.2/T7.3/T7.4, decisions
// D6–D9). Recipients are members with an expiry, not subscribers, so each axis
// row states what they hold and until when. A near-expiry gifted axis gets a
// banner (T7.4); an axis they lack gets a gift-safe standalone CTA (T7.3) — the
// per-currency CheckoutModal for that single tier, which by construction never
// offers Bundle while a gift covers the other axis (D7).

const NEAR_EXPIRY_DAYS = 14;

type AxisKey = "arkPlus" | "circle";
type StandaloneTier = "ark-plus" | "circle";

const AXIS: Record<
  AxisKey,
  { tier: StandaloneTier; other: AxisKey; label: string; noun: string }
> = {
  arkPlus: { tier: "ark-plus", other: "circle", label: "Ark+", noun: "the private feed & members-only show" },
  circle: { tier: "circle", other: "arkPlus", label: "Community", noun: "the Ark community" },
};

// Null rather than "" so callers can drop the whole clause; the dates here are
// Stripe instants, so they stay in the member's own timezone.
function fmtDate(iso: string | null): string | null {
  return formatTimestamp(iso, "long") || null;
}

function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.ceil((ms - now) / 86_400_000);
}

function AxisIcon({ axis }: { axis: AxisKey }) {
  return axis === "arkPlus" ? <HeadphonesIcon /> : <ChatIcon />;
}

// The date/status line under an active axis, phrased by source.
function accessLine(a: AxisAccess): string {
  if (a.source === "gift") {
    const until = fmtDate(a.expiresAt);
    return until ? `Gift access until ${until}` : "Gift access";
  }
  // subscription
  const cancelAt = fmtDate(a.expiresAt);
  if (cancelAt) return `Access until ${cancelAt} · won't renew`;
  const renews = fmtDate(a.renewsAt);
  return renews ? `Renews ${renews}` : "Active";
}

export function EntitlementAccess({
  me,
  onRefresh,
}: {
  me: Me;
  onRefresh: () => void;
}) {
  const axes = me.axes;
  // A checkout for the standalone tier the member is missing / renewing, or null.
  const [checkout, setCheckout] = useState<{
    tier: StandaloneTier;
    plan: "monthly" | "yearly";
  } | null>(null);
  // The in-flight / result state of a D9 "switch to the bundle" action.
  const [bundle, setBundle] = useState<
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "ok"; effectiveAt?: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // Captured once (render must stay pure) — a stable "now" for the near-expiry
  // window is fine; the page reloads/refetches on any real state change.
  const [now] = useState(() => Date.now());

  // Without axes (a stale cached /api/me) there's nothing per-axis to render;
  // the rest of the dashboard still works.
  if (!axes) return null;

  // Upgrade the member's existing single-axis subscription to the bundle so the
  // expiring gifted axis becomes subscription-backed — D9's "switch to Bundle
  // via change-tier" rather than a second standalone sub. Needs the sub's plan,
  // fetched on demand; falls back to a standalone checkout if it can't be read.
  const switchToBundle = async () => {
    setBundle({ kind: "working" });
    const sub = await getMySubscription();
    const plan = sub.plan ?? null;
    if (!plan) {
      // Can't safely change-tier without the cadence — fall back to standalone.
      setBundle({ kind: "idle" });
      setCheckout({ tier: "ark-plus", plan: "monthly" });
      return;
    }
    const r = await changeTier({ tier: "bundle", plan });
    if (r.ok) {
      setBundle({ kind: "ok", effectiveAt: r.effective_at });
      onRefresh();
    } else {
      setBundle({
        kind: "error",
        message: r.error ?? "Could not switch to the bundle — please try again.",
      });
    }
  };

  // Near-expiry banners: one per gifted axis inside the window (T7.4). When the
  // OTHER axis is a live subscription, offer the bundle switch (D9); otherwise a
  // standalone renewal of the gifted axis.
  const banners = (["arkPlus", "circle"] as AxisKey[]).flatMap((key) => {
    const a = axes[key];
    if (!a.active || a.source !== "gift") return [];
    const days = daysUntil(a.expiresAt, now);
    if (days === null || days > NEAR_EXPIRY_DAYS || days < 0) return [];
    const meta = AXIS[key];
    const otherIsSub = axes[meta.other].active && axes[meta.other].source === "subscription";
    const until = fmtDate(a.expiresAt);
    return [
      <div
        key={`banner-${key}`}
        role="status"
        className="mb-6 border border-[#e8a33d]/50 bg-[#e8a33d]/10 px-4 py-3 text-body-sm text-fg-strong"
      >
        <p>
          Your gifted <span className="font-semibold">{meta.label}</span> access
          {until ? ` ends on ${until}` : " is ending soon"}
          {typeof days === "number"
            ? ` — ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`
            : ""}
          . Keep it going so you don't lose access.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          {otherIsSub ? (
            <button
              type="button"
              onClick={switchToBundle}
              disabled={bundle.kind === "working"}
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
            >
              {bundle.kind === "working" ? "Switching…" : "Add it to your plan →"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCheckout({ tier: meta.tier, plan: "monthly" })}
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Keep {meta.label} →
            </button>
          )}
        </div>
      </div>,
    ];
  });

  return (
    <div className="mb-10">
      {banners}

      {bundle.kind === "ok" ? (
        <p className="mb-6 border border-cyan/50 bg-cyan/10 px-4 py-3 text-body-sm text-cyan" aria-live="polite">
          You're on the bundle now — both Ark+ and the Community are on your
          subscription
          {bundle.effectiveAt ? `, effective ${fmtDate(bundle.effectiveAt)}` : ""}.
        </p>
      ) : bundle.kind === "error" ? (
        <p className="mb-6 text-body-sm text-danger" aria-live="polite">
          {bundle.message}
        </p>
      ) : null}

      <h2 className="label text-cyan">Your access</h2>
      <div className="mt-4 divide-y divide-rule border-y border-rule">
        {(["arkPlus", "circle"] as AxisKey[]).map((key) => {
          const a = axes[key];
          const meta = AXIS[key];
          return (
            <div
              key={key}
              className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex gap-4">
                <div className={a.active ? "mt-0.5 text-cyan" : "mt-0.5 text-fg-faint"}>
                  <AxisIcon axis={key} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-[18px] leading-tight text-fg-strong">
                      {meta.label}
                    </h3>
                    {a.active ? (
                      <span className="inline-flex items-center border border-rule px-2 py-0.5 text-[11px] uppercase tracking-button text-fg-muted">
                        {a.source === "gift" ? "🎁 Gift" : "Subscription"}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-body-sm text-fg-muted">
                    {a.active ? accessLine(a) : `You don't have ${meta.label} yet.`}
                  </p>
                </div>
              </div>
              {!a.active ? (
                <button
                  type="button"
                  onClick={() => setCheckout({ tier: meta.tier, plan: "monthly" })}
                  className="inline-flex shrink-0 items-center gap-2 self-start border border-cyan px-4 py-2 button-text font-display font-bold text-cyan transition hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:self-auto"
                >
                  Get {meta.label} →
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {checkout ? (
        <CheckoutModal
          open
          plan={checkout.plan}
          tier={checkout.tier}
          onClose={() => {
            setCheckout(null);
            onRefresh();
          }}
        />
      ) : null}
    </div>
  );
}
