// Admin member-directory contract, shared by the API route and the SPA client.
//
// The directory's spine is the Neon `membership` table (opaque, PII-free); each
// entry's email/name is hydrated live from Stripe at read time and never
// persisted. Activation ("has the member set up a private feed?") comes from
// sc_feed_activations, keyed by email. See server/routes/admin-members.ts.

// A member's tier. `free` (no membership row) only appears via email search,
// where a Stripe customer may exist without being a paying member.
export type MemberTier = "ark-plus" | "circle" | "bundle" | "free";

// The tiers an admin can filter by (the three paid SKUs).
export type MemberTierFilter = "ark-plus" | "circle" | "bundle";

export type MemberDirectoryEntry = {
  auth0Sub: string | null; // null for a Stripe customer with no membership row
  email: string | null; // null for gift/comp members (no Stripe customer) or a deleted customer
  name: string | null;
  tier: MemberTier | null;
  status: string | null; // Stripe subscription status, or 'active' for gifts
  stripeCustomerId: string | null;
  stripeCustomerUrl: string | null; // dashboard.stripe.com link (mode-aware), null when no customer
  activated: boolean; // ≥1 currently-activated private feed
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  // Per-axis gift expiries (D4): a gift extends a specific entitlement axis, so
  // an Ark+ gift and a Community gift can run concurrently with independent end
  // dates. Null on either axis = no gift term for it.
  arkPlusGiftExpiresAt: string | null;
  circleGiftExpiresAt: string | null;
};

export type MemberDirectoryFilter = {
  email?: string; // exact-match lookup; when set, pagination is ignored
  tier?: MemberTierFilter;
  activation?: "activated" | "unactivated";
};

export type MemberDirectoryPage = {
  members: MemberDirectoryEntry[];
  hasMore: boolean;
  nextOffset: number | null;
};
