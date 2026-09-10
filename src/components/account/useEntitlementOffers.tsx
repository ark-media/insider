import { useState, type ReactNode } from "react";
import type { BundleUpgradePreview, Me } from "../../lib/auth";
import { changeTier, getBundleUpgradePreview } from "../../lib/auth";
import {
  AXIS,
  fmtDate,
  settlementOf,
  type AxisKey,
  type StandaloneTier,
} from "../../lib/entitlement-axes";
import { CheckoutModal } from "../CheckoutModal";
import { BundleConfirm } from "./BundleConfirm";
import { NOTHING_TO_PAY_TODAY, nextBillLine } from "../../../shared/billing-copy";

// "What you don't have yet" on the membership tab (T7.2/T7.3/T7.4, decisions
// D6–D9).
//
// This was a "Your access" list of BOTH axes, which restated for the active one
// exactly what the plan card above it already says — same product, same status,
// same renewal date, twice on one screen. The rows for an axis the member
// already holds are gone; only the axis they LACK is offered, and it's offered
// as one more card in "Jump back in" rather than as a section of its own.
//
// That last part is why this is a hook and not a component: the offer has to
// render as a sibling of the other jump cards (same grid, same card), while the
// gift banner and the confirm panel it opens stay full-width above them. One
// state machine, two places on the page — so the page composes, and this owns
// the flow.
//
// The near-expiry gift banner stays. It isn't a status row — a gift running out
// in nine days is the one thing on this page with a deadline, and the plan card
// can't carry it (a gift has no subscription to describe). An axis they lack
// gets a gift-safe standalone CTA (T7.3) — the per-currency CheckoutModal for
// that single tier, which by construction never offers Bundle while a gift
// covers the other axis (D7).

const NEAR_EXPIRY_DAYS = 14;

function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.ceil((ms - now) / 86_400_000);
}

// The state of a D9 "switch to the bundle" action. The switch is a real,
// immediate price change, so it goes through a confirm step that states what
// the new price is before anything is billed — never straight off the row CTA.
//
// `error` carries the axis and preview it failed on, and `ok` carries the
// preview it succeeded on, because both still have something to say about the
// member's own numbers: a failure has to leave the panel on screen to retry
// from, and a success has to state the settlement in the member's own cadence
// rather than a hardcoded month.
type BundleState =
  | { kind: "idle" }
  | { kind: "loading"; axis: AxisKey }
  | { kind: "confirm"; axis: AxisKey; preview: BundleUpgradePreview }
  | { kind: "working"; axis: AxisKey; preview: BundleUpgradePreview }
  | { kind: "error"; axis: AxisKey; preview: BundleUpgradePreview; message: string }
  // The preview itself failed, so there are no numbers to confirm against and
  // nothing to retry inside the panel. Distinct from `error` for that reason.
  | { kind: "preview-error"; axis: AxisKey }
  | { kind: "ok"; immediate: boolean; preview: BundleUpgradePreview; effectiveAt?: string };

// One axis the member could add, in the shape a jump card renders: what it's
// called, what they're missing, and the single action that starts the flow.
export type AxisOffer = {
  key: AxisKey;
  title: string;
  body?: string;
  cta: string;
  disabled: boolean;
  onSelect: () => void;
};

export function useEntitlementOffers({
  me,
  onRefresh,
}: {
  me: Me;
  onRefresh: () => void;
}): {
  // Gift banners, the confirm panel and the checkout modal: full-width, above
  // the cards. Null when there's nothing to say.
  notices: ReactNode;
  offers: AxisOffer[];
} {
  const axes = me.axes;
  // A checkout for the standalone tier the member is missing / renewing, or null.
  const [checkout, setCheckout] = useState<{
    tier: StandaloneTier;
    plan: "monthly" | "yearly";
  } | null>(null);
  const [bundle, setBundle] = useState<BundleState>({ kind: "idle" });
  // Captured once (render must stay pure) — a stable "now" for the near-expiry
  // window is fine; the page reloads/refetches on any real state change.
  const [now] = useState(() => Date.now());

  // Without axes (a stale cached /api/me) there's nothing per-axis to offer;
  // the rest of the dashboard still works.
  if (!axes) return { notices: null, offers: [] };

  // Step 1 of the bundle switch: read what the change will cost and when, so
  // the confirm panel can state it. A member without a readable live
  // subscription (or cadence) can't be change-tiered at all — they fall back to
  // buying the missing axis standalone, as before.
  const openBundleConfirm = async (axis: AxisKey) => {
    setBundle({ kind: "loading", axis });
    const result = await getBundleUpgradePreview();
    // "No live subscription to change" and "the request failed" are opposite
    // instructions and used to arrive as the same null. Only the first is a
    // reason to sell a standalone subscription instead: doing that on a failure
    // drops a member who already HAS a healthy subscription into buying a
    // second one, which the single-active-subscription guard then refuses with
    // an "already a member" screen they didn't ask for.
    if (result.kind === "none") {
      setBundle({ kind: "idle" });
      setCheckout({ tier: AXIS[axis].tier, plan: "monthly" });
      return;
    }
    if (result.kind === "error") {
      setBundle({ kind: "preview-error", axis });
      return;
    }
    setBundle({ kind: "confirm", axis, preview: result.preview });
  };

  // Step 2: move the member's existing single-axis subscription onto the bundle
  // so the axis they're adding rides that same subscription — D9's "switch to
  // Bundle via change-tier" rather than a second standalone sub billed
  // alongside it. Gaining an entitlement is immediate + prorated server-side.
  const confirmBundle = async () => {
    if (bundle.kind !== "confirm") return;
    const { axis, preview } = bundle;
    setBundle({ kind: "working", axis, preview });
    const r = await changeTier({
      tier: "bundle",
      plan: preview.plan,
    });
    if (r.ok) {
      setBundle({
        kind: "ok",
        immediate: r.timing !== "period_end",
        preview,
        effectiveAt: r.effective_at,
      });
      onRefresh();
    } else {
      // Back to `confirm`, not away from it: the panel keeps the numbers, so a
      // retry is one click rather than a second preview round trip.
      setBundle({
        kind: "error",
        axis,
        preview,
        message: r.error ?? "Could not switch to the bundle — please try again.",
      });
    }
  };

  // Any in-flight step of the switch disables both entry points, so a member
  // can't start a second one from the banner while the row's is resolving.
  const bundleBusy = bundle.kind === "loading" || bundle.kind === "working";
  const bundleCta = bundle.kind === "loading" ? "Checking…" : null;

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
          Your gifted <span className="font-semibold">{meta.inline}</span> access
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
              onClick={() => openBundleConfirm(key)}
              disabled={bundleBusy}
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
            >
              {bundleCta ?? "Add it to your plan →"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCheckout({ tier: meta.tier, plan: "monthly" })}
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Keep {meta.inline} →
            </button>
          )}
        </div>
      </div>,
    ];
  });

  // Only the axes the member is missing: a member who holds both is offered
  // nothing, rather than being shown a card restating what the plan card above
  // already says.
  const offers: AxisOffer[] = (["arkPlus", "circle"] as AxisKey[])
    .filter((key) => !axes[key].active)
    .map((key) => {
      const meta = AXIS[key];
      // When the OTHER axis is already a live subscription, adding this one
      // means moving that subscription onto the Bundle (D9) — not buying a
      // second standalone sub beside it, which would bill the member twice for
      // a plan that already contains what they're adding. A GIFT on the other
      // axis doesn't qualify: it expires, so this axis has to be able to stand
      // on its own (D7).
      const upgradeToBundle =
        axes[meta.other].active && axes[meta.other].source === "subscription";
      return {
        key,
        title: meta.label,
        cta: upgradeToBundle
          ? (bundleCta ?? `Add ${meta.inline}`)
          : `Get ${meta.inline}`,
        disabled: upgradeToBundle && bundleBusy,
        onSelect: upgradeToBundle
          ? () => void openBundleConfirm(key)
          : () => setCheckout({ tier: meta.tier, plan: "monthly" }),
      };
    });

  const panel =
    bundle.kind === "confirm" ||
    bundle.kind === "working" ||
    bundle.kind === "error" ? (
      // `working` and `error` carry the same preview so the panel stays on
      // screen, numbers intact, while the switch runs and if it fails.
      <BundleConfirm
        axis={bundle.axis}
        alreadyActive={axes[bundle.axis].active}
        preview={bundle.preview}
        working={bundle.kind === "working"}
        error={bundle.kind === "error" ? bundle.message : null}
        onConfirm={confirmBundle}
        onCancel={() => setBundle({ kind: "idle" })}
      />
    ) : bundle.kind === "preview-error" ? (
      <div
        className="mb-6 border border-danger/50 px-4 py-3 text-body-sm text-fg-strong"
        role="alert"
      >
        <p className="text-danger">
          We couldn't read what this change would cost. Nothing has been
          charged.
        </p>
        <button
          type="button"
          onClick={() => void openBundleConfirm(bundle.axis)}
          className="mt-3 inline-flex items-center px-2 py-1 text-body-sm text-fg underline underline-offset-4 transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Try again
        </button>
      </div>
    ) : bundle.kind === "ok" ? (
      <p
        className="mb-6 border border-cyan/50 bg-cyan/10 px-4 py-3 text-body-sm text-cyan"
        aria-live="polite"
      >
        {bundle.immediate
          ? // Same facts the panel stated a moment ago, from the same module:
            // the banner used to hardcode "the rest of this month" and the
            // charge direction, which contradicted the confirm step for every
            // yearly member and every above-bundle pay-what-you-can one.
            `You're in — your membership covers Ark+ and the Fold now. ${NOTHING_TO_PAY_TODAY} ${nextBillLine(
              {
                plan: bundle.preview.plan,
                renewsOn: fmtDate(bundle.preview.renewsAt),
                settlement: settlementOf(bundle.preview),
              },
            )}`
          : bundle.effectiveAt
            ? `Your membership covers Ark+ and the Fold from ${fmtDate(bundle.effectiveAt)}.`
            : "Your membership covers Ark+ and the Fold now."}
      </p>
    ) : null;

  const modal = checkout ? (
    <CheckoutModal
      open
      plan={checkout.plan}
      tier={checkout.tier}
      onClose={() => {
        setCheckout(null);
        onRefresh();
      }}
    />
  ) : null;

  // Nothing pending and nothing to warn about: no wrapper, so the page doesn't
  // carry an empty box (and its margin) above the cards.
  const notices =
    banners.length === 0 && !panel && !modal ? null : (
      <div className="mt-12">
        {banners}
        {panel}
        {modal}
      </div>
    );

  return { notices, offers };
}
