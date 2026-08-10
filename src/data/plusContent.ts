// Per-entitlement copy for the /plus Hero. The page is a single landing page
// (see [Subscribe nav IA]); its content personalizes to what the viewer doesn't
// already own so a member sees an upsell for the missing piece rather than the
// generic guest pitch. Copy only — kept out of the component (like
// pricingTiers.ts) so the section reads from one place.

import type { SubscriberAuthState } from "../lib/subscriberAuth";

// Who's looking at /plus, in terms of what they still need:
// - guest         — signed out, or a free member (owns neither axis): sell it all
// - add-community — owns Ark+, lacks Community: sell the community
// - add-arkplus   — owns Community, lacks Ark+: sell the private feed
// - full          — owns both: nothing to sell; affirm + point at account/gift
export type PlusAudience = "guest" | "add-community" | "add-arkplus" | "full";

export function plusAudience(state: SubscriberAuthState): PlusAudience {
  if (state.kind !== "member") return "guest";
  const { arkPlus, circle } = state.me.entitlements;
  if (arkPlus && circle) return "full";
  if (arkPlus) return "add-community";
  if (circle) return "add-arkplus";
  return "guest";
}

// A two-line heading with a single cyan accent span. `line2Accent` sits between
// `line2Pre` and `line2Post`, so the accent can land anywhere on the second line.
type Heading = {
  line1: string;
  line2Pre: string;
  line2Accent: string;
  line2Post: string;
};

export type HeroContent = {
  eyebrow: string;
  head: Heading;
  lead: string;
  // `href` renders an in-page anchor (to #pricing); `to` renders a router Link
  // (full members have nothing to buy, so they get a link to /account instead).
  cta: { label: string; href?: string; to?: string };
  giftLabel: string;
};

export const HERO_CONTENT: Record<PlusAudience, HeroContent> = {
  guest: {
    eyebrow: "Ark+",
    head: {
      line1: "Support coverage you can trust.",
      line2Pre: "",
      line2Accent: "Get more in return.",
      line2Post: "",
    },
    lead: "Ark+ is our premium membership, offering ad-free podcasts, unlimited access to all written content, and full access to the Ark community.",
    cta: { label: "Become a member", href: "#pricing" },
    giftLabel: "Gift Ark+",
  },
  "add-community": {
    eyebrow: "The Ark Community",
    head: {
      line1: "You have the feed.",
      line2Pre: "Now join the ",
      line2Accent: "community.",
      line2Post: "",
    },
    lead: "You already get Call Me Back AMA ad-free and the members-only newsletters. Add the Ark community — conversations with the hosts, live member events, and Dan's book club.",
    cta: { label: "Add Community", href: "#pricing" },
    giftLabel: "Gift a membership",
  },
  "add-arkplus": {
    eyebrow: "Ark+",
    head: {
      line1: "You're in the room.",
      line2Pre: "Now go ",
      line2Accent: "ad-free.",
      line2Post: "",
    },
    lead: "You're already part of the Ark community. Add Ark+ — Call Me Back AMA as a private, ad-free feed, the full network ad-free, and the members-only newsletters.",
    cta: { label: "Add Ark+", href: "#pricing" },
    giftLabel: "Gift a membership",
  },
  full: {
    eyebrow: "Membership",
    head: {
      line1: "You have the full",
      line2Pre: "Ark Media ",
      line2Accent: "experience.",
      line2Post: "",
    },
    lead: "You have Ark+ and the Ark community — the private, ad-free feed, the members-only newsletters, and the full community. Thank you for being a member.",
    cta: { label: "Manage your membership", to: "/account" },
    giftLabel: "Gift a membership",
  },
};
