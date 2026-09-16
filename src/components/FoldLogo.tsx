import wordmarkDark from "../assets/fold-wordmark.png";
import wordmarkLight from "../assets/fold-wordmark-light.png";
import markSrc from "../assets/fold-mark.png";
import { useTheme } from "../lib/theme";
import { ArkPlusMark } from "./ArkPlusMark";
import type { ProductMark } from "../data/pricingTiers";

/**
 * The Fold horizontal lockup (sail mark + wordmark), themed to the active
 * background — same contract as {@link ArkLogo}: size it with a height class,
 * never a pixel prop, so call sites can go responsive. The lockup is ~5.3:1.
 *
 * `max-w-full` + `object-contain` guard the same failure ArkLogo does: in a
 * tight flex row the width gets clamped while the height class holds, which
 * would squash the wordmark horizontally.
 */
export function FoldLogo({ className = "h-10" }: { className?: string }) {
  const { theme } = useTheme();
  const src = theme === "light" ? wordmarkDark : wordmarkLight;

  return (
    <img
      src={src}
      width={1200}
      height={225}
      className={`w-auto max-w-full object-contain object-left ${className}`}
      alt="The Fold"
    />
  );
}

/**
 * The sail mark on its own. Not exported: surfaces that want it want a *row* of
 * product marks, so {@link ProductMarks} below is the entry point. The artwork
 * is a transparent PNG of the two gradient sails, so unlike {@link ArkPlusMark}
 * it carries no field of its own and needs no light/dark swap.
 *
 * Decorative by default (the adjacent label says "The Fold"), so `alt` is empty
 * and the image is hidden from assistive tech; pass `alt` where nothing else
 * names it. Size it with a height class — the mark is ~1.39:1, not square, so a
 * square class pair would letterbox it.
 */
function FoldMark({
  className = "h-8",
  alt = "",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={markSrc}
      width={512}
      height={369}
      loading="lazy"
      decoding="async"
      alt={alt}
      {...(alt === "" ? { "aria-hidden": true } : {})}
      className={`w-auto shrink-0 object-contain ${className}`}
    />
  );
}

/**
 * The row of product marks that heads a tier card / checkout — Ark+'s app icon,
 * the Fold's sail, or both for the Bundle. Kept here rather than inline at each
 * call site because the two marks come from different artwork families and are
 * sized by different rules: {@link ArkPlusMark} is a square app icon that needs a
 * matched w/h pair (a bare height class leaves it at its intrinsic 256px width,
 * letterboxed inside its own border), while {@link FoldMark} is a ~1.39:1
 * transparent lockup that must keep `w-auto`. Only a shared box gets both right.
 *
 * `size` is a token, not a class, so Tailwind can see the literal class strings.
 * Decorative — every call site prints the tier label beside it.
 */
const MARK_SIZE = {
  sm: { square: "size-5", height: "h-5" },
  md: { square: "size-7", height: "h-7" },
} as const;

export function ProductMarks({
  marks,
  size = "md",
}: {
  marks: readonly ProductMark[];
  size?: keyof typeof MARK_SIZE;
}) {
  if (marks.length === 0) return null;

  const { square, height } = MARK_SIZE[size];

  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      {marks.map((m) =>
        m === "fold" ? (
          <FoldMark key={m} className={height} />
        ) : (
          <ArkPlusMark key={m} className={square} />
        ),
      )}
    </span>
  );
}
