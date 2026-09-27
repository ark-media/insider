import { useState } from "react";
import {
  currencySymbol,
  decimalsForCurrency,
  formatMajor,
  toMajor,
} from "../lib/currency";
import {
  SLIDER_STEPS,
  amountFromPos,
  posFromAmount,
  snapStep,
} from "../lib/pwycSlider";

type Plan = "monthly" | "yearly";

// The slider's drag ceiling and the typed safety cap are expressed as multiples
// of the plan's floor so they hold in any currency (a fixed "$3,600" is
// meaningless in ¥ or ₪). SLIDER_MAX = the top of the *drag range* (not a hard
// cap — the field accepts up to the input max beyond it). ~14.4× the floor
// mirrors the $250 → $3,600 USD range (bundle yearly); ~400× is the typed
// ceiling. The curve/snap math lives in ../lib/pwycSlider.
const SLIDER_MAX_MULTIPLE = 14.4;
const INPUT_MAX_MULTIPLE = 400;

// The amount a picker value stands for, in MAJOR units: `value` is what the
// member chose ("" = the floor), clamped into [floor, input max] so a sub-floor
// entry snaps up. `isCustom` = strictly above the floor, which is when a
// caller sends an amount at all rather than the catalog price.
export function resolveAmount(
  value: string,
  floorMinor: number | null,
  factor: number,
): { floorMajor: number | null; effectiveMajor: number | null; isCustom: boolean } {
  const floorMajor = floorMinor !== null ? toMajor(floorMinor, factor) : null;
  if (floorMajor === null) return { floorMajor, effectiveMajor: null, isCustom: false };
  const inputMax = floorMajor * INPUT_MAX_MULTIPLE;
  const parsed = value.trim() === "" ? null : Number(value);
  const effectiveMajor =
    parsed !== null && Number.isFinite(parsed)
      ? Math.min(inputMax, Math.max(floorMajor, parsed))
      : floorMajor;
  return { floorMajor, effectiveMajor, isCustom: effectiveMajor > floorMajor };
}

// Pay what you choose: a hero amount that can be tapped to type an exact
// figure, a slider on an eased curve, and the minimum beneath. Controlled —
// `value` is the chosen amount as a string in MAJOR units of `currency` ("" =
// the floor), and `onChange` hands back the next one. Used by checkout and by
// the account page's plan changes, so the two read as the same control.
//
// Remount it (a `key`) when the currency changes: a figure typed in one
// currency means nothing in another.
export function AmountPicker({
  plan,
  currency,
  factor,
  floorMinor,
  value,
  onChange,
  onCommit,
  nudge = false,
  onInteract,
}: {
  plan: Plan;
  currency: string;
  factor: number;
  // Null while the floor loads: the picker renders disabled.
  floorMinor: number | null;
  value: string;
  onChange: (value: string) => void;
  // A settled choice (slider released, typed figure committed), for analytics.
  onCommit?: (amountMajor: number, isCustom: boolean) => void;
  // The one-shot "drag me" hint on the thumb (checkout's first screen).
  nudge?: boolean;
  onInteract?: () => void;
}) {
  // Tap-to-type: while editing, the hero amount becomes an input backed by this
  // draft so the slider doesn't twitch on every keystroke — it commits on blur.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const intervalLabel = plan === "yearly" ? "year" : "month";
  const shortInterval = plan === "yearly" ? "yr" : "mo";

  const { floorMajor, effectiveMajor, isCustom } = resolveAmount(value, floorMinor, factor);
  // Display/input decimals follow the currency (0 for JPY/HUF/TWD), NOT the
  // charge factor — HUF/TWD charge in hundredths but show whole units, so the
  // field must round to whole to keep the minor amount divisible by 100.
  const decimals = decimalsForCurrency(currency, factor);
  const sliderMaxMajor = floorMajor !== null ? floorMajor * SLIDER_MAX_MULTIPLE : 0;
  const inputMaxMajor = floorMajor !== null ? floorMajor * INPUT_MAX_MULTIPLE : 0;
  const step = floorMajor !== null ? snapStep(floorMajor) : 1;

  // Thumb position + fill %, derived from the amount via the eased curve. Above
  // sliderMax the thumb pegs at the far right (posFromAmount clamps).
  const sliderPos =
    floorMajor !== null && effectiveMajor !== null
      ? posFromAmount(effectiveMajor, floorMajor, sliderMaxMajor)
      : 0;
  const sliderPct = (sliderPos / SLIDER_STEPS) * 100;

  const roundMajor = (v: number) =>
    decimals === 0 ? Math.round(v) : Math.round(v * 100) / 100;

  const commitDraft = () => {
    setEditing(false);
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || floorMajor === null) return;
    const clean = roundMajor(Math.min(inputMaxMajor, Math.max(floorMajor, n)));
    onChange(clean <= floorMajor ? "" : String(clean));
    onCommit?.(clean, clean > floorMajor);
  };

  const startEdit = () => {
    if (floorMajor === null) return;
    onInteract?.();
    setDraft(effectiveMajor !== null ? String(effectiveMajor) : "");
    setEditing(true);
  };

  return (
    <>
      {/* Hero amount — the focal point. Tap to type an exact figure. */}
      <div className="mt-3 flex items-baseline gap-2">
        {editing ? (
          <>
            <span className="display-upright text-[clamp(2.25rem,8vw,3rem)] leading-none text-fg-strong">
              {currencySymbol(currency)}
            </span>
            <input
              type="number"
              inputMode="decimal"
              aria-label={`Amount per ${intervalLabel}`}
              autoFocus
              min={floorMajor ?? undefined}
              max={inputMaxMajor}
              step={decimals === 0 ? 1 : "any"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDraft();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              className="pwyc-amount-input display-upright min-w-0 bg-transparent text-[clamp(2.25rem,8vw,3rem)] leading-none text-fg-strong outline-none"
            />
            <span className="text-lg text-fg-muted">/{shortInterval}</span>
          </>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            disabled={floorMajor === null}
            className="group inline-flex items-baseline gap-2 rounded-sm text-left outline-none transition disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
            aria-label={
              effectiveMajor !== null
                ? `Amount: ${formatMajor(effectiveMajor, currency)} per ${intervalLabel}. Tap to type an exact figure.`
                : "Amount, tap to type"
            }
          >
            <span className="display-upright text-[clamp(2.25rem,8vw,3rem)] leading-none text-fg-strong tabular-nums">
              {effectiveMajor !== null ? formatMajor(effectiveMajor, currency) : "—"}
            </span>
            <span className="text-lg text-fg-muted">/{shortInterval}</span>
            {/* Pencil affordance — signals the amount is editable. */}
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4 shrink-0 self-center text-fg-faint transition group-hover:text-cyan"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        )}
      </div>

      <input
        type="range"
        aria-label={`Amount per ${intervalLabel}`}
        aria-valuetext={
          effectiveMajor !== null
            ? `${formatMajor(effectiveMajor, currency)} per ${intervalLabel}`
            : undefined
        }
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={sliderPos}
        disabled={floorMajor === null}
        onPointerDown={onInteract}
        onChange={(e) => {
          if (floorMajor === null) return;
          onInteract?.();
          const a = amountFromPos(Number(e.target.value), floorMajor, sliderMaxMajor, step);
          // The leftmost stop maps back to the floor ("").
          onChange(a <= floorMajor ? "" : String(a));
        }}
        onBlur={() => {
          if (effectiveMajor === null) return;
          onCommit?.(effectiveMajor, isCustom);
        }}
        className={`pwyc-slider mt-5 w-full${nudge ? " pwyc-slider--nudge" : ""}`}
        style={{ "--pct": `${sliderPct}%` } as React.CSSProperties}
      />

      {/* Floor label only — we intentionally don't advertise a maximum, since
          the amount field accepts more than the slider's drag range. */}
      {floorMajor !== null ? (
        <div className="mt-2 text-xs tabular-nums text-fg-faint">
          {formatMajor(floorMajor, currency)} minimum
        </div>
      ) : null}
    </>
  );
}
