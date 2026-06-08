import { CIRCLE_OPEN_LINKS } from "../lib/circle";

// The three ways into the Ark+ community (Circle) app: the official App Store
// and Google Play download badges plus an "Open in browser" pill for the web
// app. Apple's and Google's brand rules forbid recreating or recoloring the
// store lockups, so we render their official SVGs unmodified (public/badges/*)
// and only build a matching-height neutral pill for web. Use this anywhere we
// surface the iOS / Android / Web options so the treatment stays consistent.
export function CommunityAppLinks({ className }: { className?: string }) {
  return (
    // Two store badges on top, then a full-width "Open in browser" bar that
    // stretches to match the badges' combined width — reads as one tidy block
    // rather than three buttons of mismatched width.
    <div className={`inline-flex w-fit flex-col gap-3 ${className ?? ""}`}>
      <div className="flex flex-wrap gap-3">
        <BadgeLink
          href={CIRCLE_OPEN_LINKS.ios}
          src="/badges/app-store.svg"
          alt="Download on the App Store"
        />
        <BadgeLink
          href={CIRCLE_OPEN_LINKS.android}
          src="/badges/google-play.svg"
          alt="Get it on Google Play"
        />
      </div>
      <a
        href={CIRCLE_OPEN_LINKS.web}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-rule-strong bg-navy-900 px-4 text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <GlobeIcon />
        <span className="button-text font-display font-bold">Open in browser</span>
      </a>
    </div>
  );
}

function BadgeLink({
  href,
  src,
  alt,
}: {
  href: string;
  src: string;
  alt: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex rounded-[10px] transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      {/* The two store badges share a 40-unit-tall viewBox, so a fixed height
          renders them at matching size; width scales to each lockup. */}
      <img src={src} alt={alt} className="h-12 w-auto" />
    </a>
  );
}

function GlobeIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z" />
    </svg>
  );
}
