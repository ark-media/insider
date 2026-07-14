import { imageVariants } from "./image-variants";

/**
 * Builds a `srcset` for a static image in /public from the widths that
 * `scripts/gen-image-variants.sh` actually wrote to disk.
 *
 * Returns undefined when the image has no variants (an unknown path, or a
 * source small enough that no variant was worth generating) — the caller's
 * plain `src` then stands on its own, which is the correct fallback.
 */
export function srcSet(src: string): string | undefined {
  const variants = imageVariants[src];
  if (!variants || variants.length < 2) return undefined;
  return variants.map(([w, url]) => `${url} ${w}w`).join(", ");
}

/**
 * The source image's own width, for the `width`/`height` attributes. Falls back
 * to a square-ish default for images the manifest doesn't know — those render
 * without a srcset anyway, and the attributes only need to carry the aspect
 * ratio for layout stability.
 */
export function intrinsicWidth(src: string, fallback = 1200): number {
  const variants = imageVariants[src];
  if (!variants || variants.length === 0) return fallback;
  // The manifest lists widths ascending, so the source itself is last.
  return variants[variants.length - 1][0];
}

/**
 * `sizes` is a promise to the browser about the slot the image lands in, and it
 * is believed over the real layout — a wrong value is worse than none, because
 * the browser will happily pick a 400w file for a full-width phone hero and
 * upscale it. So there is deliberately no default: every call site states its
 * own. The two constants below just name the layouts that recur.
 */

/**
 * Every portrait grid (the /hosts roster, a show's host list, the home hosts
 * row) caps its portraits at the same width, so the slot no longer depends on
 * the viewport and `sizes` is just that cap. Cells narrower than the cap only
 * over-fetch within one srcset step. Keep this in step with the `max-w-*` the
 * portrait grids apply.
 */
export const PORTRAIT_SIZES = "200px";
