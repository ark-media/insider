import { socialUrls } from "../config/urls";

type Social = { label: string; href: string; icon: string };

// The brand PNGs are single-color (navy) glyphs on transparent backgrounds, so
// they'd vanish on the navy footer — and the footer flips light with the theme.
// We render each as a CSS mask tinted with `currentColor`, so the icon takes the
// link's text color (muted by default, cyan on hover) and stays legible in both
// themes for free.
//
// Profile URLs live in src/config/urls.ts (socialUrls); icon/label/order stay
// here since they're presentation.
const socials: Social[] = [
  { label: "Instagram", href: socialUrls.instagram, icon: "/social/instagram.png" },
  { label: "X", href: socialUrls.x, icon: "/social/x.png" },
  { label: "LinkedIn", href: socialUrls.linkedin, icon: "/social/linkedin.png" },
  { label: "YouTube", href: socialUrls.youtube, icon: "/social/youtube.png" },
  { label: "Spotify", href: socialUrls.spotify, icon: "/social/spotify.png" },
  { label: "Apple Podcasts", href: socialUrls.applePodcasts, icon: "/social/apple-podcasts.png" },
];

export function SocialLinks({ className = "" }: { className?: string }) {
  return (
    <ul className={`flex flex-wrap items-center gap-5 ${className}`}>
      {socials.map((s) => (
        <li key={s.label}>
          <a
            href={s.href}
            target="_blank"
            rel="noreferrer"
            aria-label={s.label}
            className="inline-flex text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <span
              aria-hidden="true"
              className="block h-5 w-5"
              style={{
                backgroundColor: "currentColor",
                WebkitMaskImage: `url(${s.icon})`,
                maskImage: `url(${s.icon})`,
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
                WebkitMaskSize: "contain",
                maskSize: "contain",
              }}
            />
          </a>
        </li>
      ))}
    </ul>
  );
}
