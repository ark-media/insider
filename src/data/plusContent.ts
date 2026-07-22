// Per-entitlement copy for the /plus Hero and Benefits sections. The page is a
// single landing page (see [Subscribe nav IA]); its content personalizes to what
// the viewer doesn't already own so a member sees an upsell for the missing
// piece rather than the generic guest pitch. Copy only — kept out of the
// components (like pricingTiers.ts) so both sections read from one place.

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
  bullets: string[];
  // `href` renders an in-page anchor (to #pricing); `to` renders a router Link
  // (full members have nothing to buy, so they get a link to /account instead).
  cta: { label: string; href?: string; to?: string };
  mark: "arkplus" | "community";
  markSub: string;
  badgeLabel: string;
  badgeValue: string;
  giftLabel: string;
};

export const HERO_CONTENT: Record<PlusAudience, HeroContent> = {
  guest: {
    eyebrow: "Ark+",
    head: {
      line1: "The full",
      line2Pre: "Ark Media ",
      line2Accent: "experience.",
      line2Post: "",
    },
    lead: "Ark+ is our premium membership, offering ad-free podcasts, unlimited access to all written content, and full access to the Ark community.",
    bullets: [
      "Inside Call Me Back — extended interviews, ad-free",
      "Members-only newsletters — sharper analysis, weekly",
      "The Ark+ community — join the hosts and other members in the room",
      "Live events and Q&As",
      "Early access to new shows",
    ],
    cta: { label: "Become a member", href: "#pricing" },
    mark: "arkplus",
    markSub: "Membership",
    badgeLabel: "Ark+ Member",
    badgeValue: "No. 00214",
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
    lead: "You already get Inside Call Me Back ad-free and the members-only newsletters. Add the Ark community — conversations with the hosts, live member events, and Dan's book club.",
    bullets: [
      "The Ark community app — talk with the hosts and fellow members",
      "Live member events and Q&As",
      "Dan's book club",
      "Exclusive members-only spaces",
    ],
    cta: { label: "Add Community", href: "#pricing" },
    mark: "community",
    markSub: "Community",
    badgeLabel: "Ark+ Member",
    badgeValue: "Add Community",
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
    lead: "You're already part of the Ark community. Add Ark+ — Inside Call Me Back as a private, ad-free feed, the full network ad-free, and the members-only newsletters.",
    bullets: [
      "Inside Call Me Back — private, ad-free feed",
      "The full Ark Media network, ad-free",
      "Members-only newsletters — sharper analysis, weekly",
      "Early access to new shows",
    ],
    cta: { label: "Add Ark+", href: "#pricing" },
    mark: "arkplus",
    markSub: "Membership",
    badgeLabel: "Community Member",
    badgeValue: "Add Ark+",
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
    bullets: [
      "Inside Call Me Back — private, ad-free feed",
      "Members-only newsletters",
      "The Ark community, live events, and Dan's book club",
    ],
    cta: { label: "Manage your membership", to: "/account" },
    mark: "arkplus",
    markSub: "Full member",
    badgeLabel: "Full Member",
    badgeValue: "No. 00214",
    giftLabel: "Gift a membership",
  },
};

export type BenefitItem = { no: string; title: string; body: string };

export type BenefitsContent = {
  head: Heading;
  intro: string;
  items: BenefitItem[];
};

// The three things Ark+ + Community grant, shown to guests and (as "what you
// have") to full members.
const ALL_THREE: BenefitItem[] = [
  {
    no: "01",
    title: "Call Me Back Ark+ Feed",
    body: "Extra weekly episode, ad-free episodes, and members-only Q&As — delivered as a private feed in the podcast app you already use.",
  },
  {
    no: "02",
    title: "Members-only newsletter",
    body: "A weekly Ark+ members newsletter with our full analysis, source notes, and more, delivered straight to your inbox.",
  },
  {
    no: "03",
    title: "The Ark Community",
    body: "Full access to the Ark community app, exclusive members-only spaces, and opportunities to connect with fellow members — plus access to Inside Call Me Back Q&A sessions.",
  },
];

export const BENEFITS_CONTENT: Record<PlusAudience, BenefitsContent> = {
  guest: {
    head: {
      line1: "Three things,",
      line2Pre: "",
      line2Accent: "one",
      line2Post: " membership.",
    },
    intro:
      "The private feed, the newsletters, and the community — all in one place. The Ark+ & Community bundle covers all three below.",
    items: ALL_THREE,
  },
  "add-community": {
    head: {
      line1: "What the",
      line2Pre: "community ",
      line2Accent: "adds.",
      line2Post: "",
    },
    intro:
      "You already have the private feed and the members-only newsletters. Here's what joining the Ark community adds.",
    items: [
      {
        no: "01",
        title: "Conversations",
        body: "The Ark community app — talk with the hosts and fellow members in exclusive, members-only spaces.",
      },
      {
        no: "02",
        title: "Live events & Q&As",
        body: "Member-only events and live Q&A sessions, including Inside Call Me Back.",
      },
      {
        no: "03",
        title: "Dan's book club",
        body: "Read along with Dan and the community, with member discussion and guest authors.",
      },
    ],
  },
  "add-arkplus": {
    head: {
      line1: "What",
      line2Pre: "Ark+ ",
      line2Accent: "adds.",
      line2Post: "",
    },
    intro:
      "You're already in the Ark community. Here's what adding Ark+ gives you.",
    items: [
      {
        no: "01",
        title: "The private feed",
        body: "Inside Call Me Back as a private, ad-free feed in the podcast app you already use — with an extra weekly episode and members-only Q&As.",
      },
      {
        no: "02",
        title: "The network, ad-free",
        body: "Every Ark Media show, ad-free.",
      },
      {
        no: "03",
        title: "Members-only newsletter",
        body: "A weekly Ark+ members newsletter with our full analysis, source notes, and more, delivered straight to your inbox.",
      },
    ],
  },
  full: {
    head: {
      line1: "Everything",
      line2Pre: "you ",
      line2Accent: "have.",
      line2Post: "",
    },
    intro: "Your membership covers all three — here's what's included.",
    items: ALL_THREE,
  },
};
