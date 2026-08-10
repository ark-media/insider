import logoDark from "../assets/logo-wordmark.png";
import logoLight from "../assets/logo-wordmark-light.png";
import { useTheme } from "../lib/theme";

/**
 * The Ark Media wordmark, themed to the active background.
 *
 * Size it with a height class (`h-[30px]`, `sm:h-9`, …) rather than a pixel
 * prop so call sites can go responsive: the lockup is ~6.8:1, so a height that
 * reads well on desktop is far too wide for a phone masthead.
 *
 * The `width`/`height` attributes carry the file's intrinsic ratio so the
 * browser reserves the box before the PNG lands. `max-w-full` + `object-contain`
 * are the guardrail: in a tight flex row the width gets clamped while the height
 * class holds, which would otherwise squash the wordmark horizontally — with
 * `contain` it scales down proportionally instead.
 */
export function ArkLogo({ className = "h-[30px]" }: { className?: string }) {
  const { theme } = useTheme();
  const src = theme === "light" ? logoDark : logoLight;

  return (
    <img
      src={src}
      width={1200}
      height={177}
      className={`w-auto max-w-full object-contain object-left ${className}`}
      alt="Ark Media"
    />
  );
}
