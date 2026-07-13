import type { Show } from "../data/shows";
import { ArkNewsDailyArtwork } from "./ArkNewsDailyArtwork";
import { GRID_IMAGE_SIZES, srcSet } from "../lib/images";

/**
 * Single source for a show's square (1:1) cover. Prefers the uploaded
 * `coverArt` image; shows without one fall back to generated art — the
 * Ark News Daily brand mark, or a branded gradient panel for everything else.
 *
 * Callers size the square with `className` on the outer box (e.g. `w-full
 * max-w-md` in a hero, nothing in a grid cell). Pass `priority` for
 * above-the-fold covers so the image isn't lazy-loaded.
 *
 * `sizes` defaults to the standard browse grid (two-up on phones, three-up from
 * `lg`). Override it anywhere the cover isn't in that grid — a wrong `sizes` is
 * worse than none, because the browser trusts it over the real layout.
 */
export function ShowCover({
  show,
  className,
  priority = false,
  sizes = GRID_IMAGE_SIZES,
}: {
  show: Show;
  className?: string;
  priority?: boolean;
  sizes?: string;
}) {
  const box = `relative aspect-square overflow-hidden ${className ?? ""}`;

  if (show.coverArt) {
    return (
      <div className={box}>
        <img
          src={show.coverArt}
          srcSet={srcSet(show.coverArt)}
          sizes={sizes}
          alt={`${show.title} — cover art`}
          width={1200}
          height={1200}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          className="h-full w-full object-cover"
        />
      </div>
    );
  }

  if (show.slug === "ark-news-daily") {
    return <ArkNewsDailyArtwork title={show.title} className={className} />;
  }

  return (
    <div
      role="img"
      aria-label={`${show.title} — cover art`}
      className={`${box} bg-gradient-to-br from-navy-800/80 via-navy-700/40 to-navy-900/80`}
    >
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 60% 50% at 30% 30%, rgb(62 181 249 / 0.55) 0%, transparent 60%)",
        }}
      />
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 50% 40% at 75% 80%, rgb(62 181 249 / 0.28) 0%, transparent 65%)",
          animationDelay: "-4.5s",
          animationDuration: "11s",
        }}
      />
      <div className="absolute inset-0 flex flex-col justify-between p-8">
        <div className="eyebrow">{show.shortTitle}</div>
        <div className="display-upright text-[clamp(2rem,4vw,3rem)] leading-[0.9] text-fg-strong">
          {show.title}
        </div>
      </div>
    </div>
  );
}
