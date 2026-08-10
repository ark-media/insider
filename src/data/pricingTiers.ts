// Shared tier metadata for the pricing card grid and the comparison table.
// Prices are NOT here — they come from Stripe (the source of truth) via
// /api/pricing. This is display copy only; actual entitlements are derived
// server-side from each tier's Stripe product.

export type Tier = "ark-plus" | "circle" | "bundle";

export type TierMeta = {
  key: Tier;
  label: string;
  blurb: string;
  includes: string[];
  featured?: boolean;
};

// The three SKUs, in card order: Ark+, then the Bundle (featured, center), then
// Community. Community is NOT part of Ark+ — it's its own tier, and the Bundle
// is what buys both. `includes` is the exact, truthful grant per tier.
export const TIERS: TierMeta[] = [
  {
    key: "ark-plus",
    label: "Ark+",
    blurb:
      "Every Ark Media podcast, ad-free, plus the members-only newsletters.",
    includes: [
      "Call Me Back AMA — private, ad-free feed",
      "The full network, ad-free",
      "Members-only newsletters",
    ],
  },
  {
    key: "bundle",
    label: "Ark+ & Community",
    blurb: "Both — the private feed and the community, one membership.",
    featured: true,
    includes: [
      "Call Me Back AMA — private, ad-free feed",
      "The full network, ad-free",
      "Members-only newsletters",
      "The Ark Media community",
      "Live member events & Q&As",
    ],
  },
  {
    key: "circle",
    label: "Community",
    blurb:
      "The Ark Media community app — conversations, member events, and Dan's book club.",
    includes: [
      "The Ark Media community",
      "Live member events & Q&As",
      "Dan's book club",
    ],
  },
];
