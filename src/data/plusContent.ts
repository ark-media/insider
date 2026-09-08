// Copy for the /plus Hero.
//
// This header is deliberately STATIC — it reads the same for a guest, a free
// reader, an Ark+ member, and a full-bundle member. /plus is the public
// "what membership is" page, and swapping its headline per entitlement made it
// a different page depending on who was looking (a signed-in member landed on
// Fold upsell copy instead of the page they expected). Personalization
// stays where it belongs: the pricing grid below only offers tiers the viewer
// doesn't already own.

// A two-line heading with a single cyan accent span. `line2Accent` sits between
// `line2Pre` and `line2Post`, so the accent can land anywhere on the second line.
type Heading = {
  line1: string;
  line2Pre: string;
  line2Accent: string;
  line2Post: string;
};

export type HeroContent = {
  head: Heading;
  lead: string;
  // `href` renders an in-page anchor (to #pricing); `to` renders a router Link.
  cta: { label: string; href?: string; to?: string };
  giftLabel: string;
  // The square card beside the headline. `src` is a path in /public so it goes
  // through srcSet() — see src/lib/images.ts.
  art: { src: string; alt: string };
};

export const HERO_CONTENT: HeroContent = {
  head: {
    line1: "Support coverage you can trust.",
    line2Pre: "",
    line2Accent: "Get more in return.",
    line2Post: "",
  },
  lead: "Ark+ subscribers fund honest coverage of Israel and Jewish life. Get exclusive content and ad-free listening across every show.",
  cta: { label: "Become a member", href: "#pricing" },
  giftLabel: "Gift Ark+",
  art: { src: "/ark-plus-hero.jpg", alt: "Ark+" },
};
