// The two entitlement axes, as the account UI names them, plus the two helpers
// that every surface touching them needs. Shared by the offer hook and the
// bundle confirm panel it opens — one place to name a product, so "the Fold"
// can't drift into "The Fold" mid-sentence on one screen and not the other.
import { formatTimestamp } from "../../shared/format-date";
import type { BundleUpgradePreview } from "./auth";
import type { Settlement } from "../../shared/billing-copy";

export type AxisKey = "arkPlus" | "circle";
export type StandaloneTier = "ark-plus" | "circle";

// `label` heads a card and starts a sentence; `inline` is the same product
// named mid-sentence, where "The Fold" would read as a stray capital ("Your
// gifted The Fold access"). Identical for Ark+, which needs no article.
export const AXIS: Record<
  AxisKey,
  { tier: StandaloneTier; other: AxisKey; label: string; inline: string }
> = {
  arkPlus: {
    tier: "ark-plus",
    other: "circle",
    label: "Ark+",
    inline: "Ark+",
  },
  circle: {
    tier: "circle",
    other: "arkPlus",
    label: "The Fold",
    inline: "the Fold",
  },
};

// Null rather than "" so callers can drop the whole clause; the dates here are
// Stripe instants, so they stay in the member's own timezone.
export function fmtDate(iso: string | null): string | null {
  return formatTimestamp(iso, "long") || null;
}

// Which way a switch to the bundle settles on the member's next bill. A
// pay-what-you-can member paying above the bundle price is owed the unused
// remainder rather than charged a difference — same "nothing today", opposite
// direction afterwards. Never 'unknown' here: unlike the follow-up email, this
// side knows both prices.
export function settlementOf(preview: BundleUpgradePreview): Settlement {
  return preview.currentCents !== null &&
    preview.bundleCents !== null &&
    preview.currentCents > preview.bundleCents
    ? "credited"
    : "charged";
}
