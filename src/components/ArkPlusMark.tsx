import markSrc from "../assets/ark-plus-mark.jpg";

/**
 * The Ark+ app-icon mark, used to badge every Ark+ CTA banner so the offer is
 * recognisable before the copy is read.
 *
 * The artwork carries its own navy field, so it is theme-independent — no
 * light/dark swap like {@link ArkLogo}. It is decorative wherever it sits next
 * to an "Ark+" label (the label already names the thing), so `alt` defaults to
 * empty and the image is hidden from assistive tech; pass `alt` on the rare
 * banner whose eyebrow doesn't say "Ark+".
 *
 * Size it with a square class pair (`h-12 w-12`) rather than a prop: the banners
 * differ in density, and the intrinsic 256px source covers every one of them at
 * 2–3× DPR. The `width`/`height` attributes reserve the box before the JPEG
 * lands so the eyebrow row doesn't jump.
 */
export function ArkPlusMark({
  className = "h-12 w-12",
  alt = "",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={markSrc}
      width={256}
      height={256}
      loading="lazy"
      decoding="async"
      alt={alt}
      {...(alt === "" ? { "aria-hidden": true } : {})}
      className={`shrink-0 border border-rule object-contain ${className}`}
    />
  );
}
