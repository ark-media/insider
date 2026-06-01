// Single-color line glyphs for the three member surfaces (Podcast, Newsletter,
// Community). Stroked in currentColor — unlike the multi-color brand marks in
// PlatformIcons — so they inherit the cyan/fg color of whatever wraps them.
// Used by the two account-page layout options (option-cards, option-stacked).
const DEFAULT_ICON_CLASS = "h-6 w-6 shrink-0";

type IconProps = { className?: string };

const baseProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

// Headphones — the private podcast feed.
export function HeadphonesIcon({ className = DEFAULT_ICON_CLASS }: IconProps) {
  return (
    <svg className={className} {...baseProps}>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="2.5" y="13.5" width="4" height="6.5" rx="1.5" />
      <rect x="17.5" y="13.5" width="4" height="6.5" rx="1.5" />
    </svg>
  );
}

// Envelope — newsletter preferences.
export function MailIcon({ className = DEFAULT_ICON_CLASS }: IconProps) {
  return (
    <svg className={className} {...baseProps}>
      <rect x="2.5" y="5" width="19" height="14" rx="1.5" />
      <path d="m3 6.5 9 6 9-6" />
    </svg>
  );
}

// Speech bubble — the Ark+ community.
export function ChatIcon({ className = DEFAULT_ICON_CLASS }: IconProps) {
  return (
    <svg className={className} {...baseProps}>
      <path d="M21 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-5.3A8 8 0 1 1 21 11.5Z" />
    </svg>
  );
}
