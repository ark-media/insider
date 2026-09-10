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
  /**
   * Which product marks head the card, in order. This is the *grant*, not the
   * label — which is why the Bundle carries both: two marks say "you get both
   * products" faster than the label does. Rendered decoratively (the label
   * beside them already names the tier).
   */
  marks: ProductMark[];
};

/** The two things a membership can grant, each with its own brand mark. */
export type ProductMark = "ark-plus" | "fold";

// The three SKUs, in card order: Ark+, then the Bundle (featured, center), then
// the Fold. The Fold is NOT part of Ark+ — it's its own tier, and the Bundle
// is what buys both. `includes` is the exact, truthful grant per tier.
export const TIERS: TierMeta[] = [
  {
    key: "ark-plus",
    label: "Ark+",
    marks: ["ark-plus"],
    blurb:
      "Every Ark Media podcast, ad-free, plus the members-only newsletter.",
    includes: [
      "Exclusive Ark+ Member's only content.",
      "The full network, ad-free",
      "Members-only newsletters",
    ],
  },
  {
    key: "bundle",
    label: "Ark+ & The Fold",
    marks: ["ark-plus", "fold"],
    blurb: "Both — the private feed and the Fold, one membership.",
    featured: true,
    includes: [
      "Exclusive Ark+ Member's only content.",
      "The full network, ad-free",
      "Members-only newsletters",
      "The Fold",
      "Live member events & Q&As",
    ],
  },
  {
    key: "circle",
    label: "The Fold",
    marks: ["fold"],
    blurb:
      "The Fold, Ark Media's members' app — conversations, member events, and Dan's book club.",
    includes: [
      "The Fold",
      "Live member events & Q&As",
      "Dan's book club",
    ],
  },
];
