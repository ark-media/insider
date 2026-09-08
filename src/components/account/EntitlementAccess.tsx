import { useState } from "react";
import type { AxisAccess, BundleUpgradePreview, Me } from "../../lib/auth";
import { changeTier, getBundleUpgradePreview } from "../../lib/auth";
import { formatMinor } from "../../lib/currency";
import { formatTimestamp } from "../../../shared/format-date";
import { CheckoutModal } from "../CheckoutModal";
import {
  NOTHING_TO_PAY_TODAY,
  nextBillLine,
  perPeriod,
  type Settlement,
} from "../../../shared/billing-copy";
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

// `label` heads the row and starts a sentence; `inline` is the same product
// named mid-sentence, where "The Fold" would read as a stray capital ("Your
// gifted The Fold access"). Identical for Ark+, which needs no article.
const AXIS: Record<
  AxisKey,
  { tier: StandaloneTier; other: AxisKey; label: string; inline: string; noun: string }
> = {
  arkPlus: {
    tier: "ark-plus",
    other: "circle",
    label: "Ark+",
    inline: "Ark+",
    noun: "the private feed & members-only show",
  },
  circle: {
    tier: "circle",
    other: "arkPlus",
    label: "The Fold",
    inline: "the Fold",
    noun: "the Fold",
  },
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

// Which way the switch settles on the member's next bill. A pay-what-you-can
// member paying above the bundle price is owed the unused remainder rather than
// charged a difference — same "nothing today", opposite direction afterwards.
// Never 'unknown' here: unlike the follow-up email, this side knows both prices.
function settlementOf(preview: BundleUpgradePreview): Settlement {
  return preview.currentCents !== null &&
    preview.bundleCents !== null &&
    preview.currentCents > preview.bundleCents
    ? "credited"
    : "charged";
}

// The confirm step for D9. Every line answers a question a member asks at
// exactly this moment, in the order they ask it: what does it cost, when do I
// get it, and what comes off my card right now?
//
// Three rules keep it out of our own vocabulary:
//
//   1. Show the move as "$8 → $25", not as a price plus an argument. The fear
//      here is that the new price is charged ON TOP of the old one, and an
//      arrow between two numbers settles that faster than a sentence can.
//   2. Say "nothing to pay today" out loud. It's the true answer and nobody
//      guesses it, because the change is settled on the next bill instead.
//   3. No "prorated", no "invoice", no "billing period". Members have bills and
//      months; proration is our word for our machinery.
function BundleConfirm({
  axis,
  alreadyActive,
  preview,
  working,
  error,
  onConfirm,
  onCancel,
}: {
  axis: AxisKey;
  // True on the near-expiry banner's entry point, where the member already has
  // this axis on a gift: the switch secures it rather than unlocking it.
  alreadyActive: boolean;
  preview: BundleUpgradePreview;
  working: boolean;
  // A failed attempt, rendered INSIDE the panel, so the numbers the member is
  // deciding on stay on screen to retry from.
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const meta = AXIS[axis];
  const { currency, minorFactor, plan } = preview;
  const bundle =
    preview.bundleCents === null
      ? null
      : formatMinor(preview.bundleCents, currency, minorFactor);
  const current =
    preview.currentCents === null
      ? null
      : formatMinor(preview.currentCents, currency, minorFactor);
  const renews = fmtDate(preview.renewsAt);
  const billLine = nextBillLine({
    plan,
    renewsOn: renews,
    settlement: settlementOf(preview),
  });

  return (
    <div className="mb-6 border border-cyan/50 bg-cyan/5 px-4 py-4">
      <h3 className="font-display text-[18px] leading-tight text-fg-strong">
        Add {meta.inline} to your membership
      </h3>
      <ul className="mt-3 space-y-2 text-body-sm text-fg">
        <li>
          {bundle ? (
            <>
              {current ? (
                <span className="font-semibold text-fg-strong">
                  {current} → {bundle} {perPeriod(plan)}.
                </span>
              ) : (
                <span className="font-semibold text-fg-strong">
                  {bundle} {perPeriod(plan)}.
                </span>
              )}{" "}
              One price for everything.
            </>
          ) : (
            <>One price for everything, not a second subscription.</>
          )}
        </li>
        <li>
          {alreadyActive
            ? `${meta.label} is yours to keep — no gap when the gift runs out.`
            : axis === "circle"
              ? "You're in right away."
              : "Your private feed is ready right away."}
        </li>
        <li>
          {NOTHING_TO_PAY_TODAY} {billLine}
        </li>
      </ul>
      {error ? (
        <p className="mt-4 text-body-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={working}
          className="inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
        >
          {working
            ? "Switching…"
            : bundle
              ? `Switch to ${bundle} ${perPeriod(plan)}`
              : `Add ${meta.inline}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={working}
          className="inline-flex items-center px-2 py-2 text-body-sm text-fg-muted underline-offset-4 transition hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </div>
  );
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
  const [bundle, setBundle] = useState<BundleState>({ kind: "idle" });
  // Captured once (render must stay pure) — a stable "now" for the near-expiry
  // window is fine; the page reloads/refetches on any real state change.
  const [now] = useState(() => Date.now());

  // Without axes (a stale cached /api/me) there's nothing per-axis to render;
  // the rest of the dashboard still works.
  if (!axes) return null;

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

  return (
    <div className="mb-10">
      {banners}

      {bundle.kind === "confirm" ||
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
      ) : null}

      {bundle.kind === "preview-error" ? (
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
      ) : null}

      {bundle.kind === "ok" ? (
        <p className="mb-6 border border-cyan/50 bg-cyan/10 px-4 py-3 text-body-sm text-cyan" aria-live="polite">
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
      ) : null}

      <h2 className="label text-cyan">Your access</h2>
      <div className="mt-4 divide-y divide-rule border-y border-rule">
        {(["arkPlus", "circle"] as AxisKey[]).map((key) => {
          const a = axes[key];
          const meta = AXIS[key];
          // When the OTHER axis is already a live subscription, adding this one
          // means moving that subscription onto the Bundle (D9) — not buying a
          // second standalone sub beside it, which would bill the member twice
          // for a plan that already contains what they're adding. A GIFT on the
          // other axis doesn't qualify: it expires, so this axis has to be able
          // to stand on its own (D7).
          const upgradeToBundle =
            axes[meta.other].active &&
            axes[meta.other].source === "subscription";
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
                    {a.active
                      ? accessLine(a)
                      : upgradeToBundle
                        ? // Deliberately no price here: a number on this line,
                          // next to what they already pay, reads as an add-on.
                          // The confirm panel is where the money is spelled out.
                          `You don't have ${meta.inline} yet — add it and your membership covers both, at one price.`
                        : `You don't have ${meta.inline} yet.`}
                  </p>
                </div>
              </div>
              {!a.active ? (
                upgradeToBundle ? (
                  <button
                    type="button"
                    onClick={() => openBundleConfirm(key)}
                    disabled={bundleBusy}
                    className="inline-flex shrink-0 items-center gap-2 self-start border border-cyan px-4 py-2 button-text font-display font-bold text-cyan transition hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60 sm:self-auto"
                  >
                    {bundleCta ?? `Add ${meta.inline} →`}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCheckout({ tier: meta.tier, plan: "monthly" })}
                    className="inline-flex shrink-0 items-center gap-2 self-start border border-cyan px-4 py-2 button-text font-display font-bold text-cyan transition hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:self-auto"
                  >
                    Get {meta.inline} →
                  </button>
                )
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
