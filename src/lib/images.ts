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
 * `sizes` for a cover/portrait in the site's standard browse grid: two-up on
 * phones, three-up from `lg`. Without this the browser assumes the image is
 * 100vw and picks a file two steps too large.
 */
export const GRID_IMAGE_SIZES = "(min-width: 1024px) 33vw, 50vw";
