import type { SubscriberAuthState } from "./subscriberAuth";

// Who the Fold login gate just turned away.
//
// The Auth0 post-login Action (auth0/actions/post-login.js) denies a Fold login
// for anyone without the `circle` entitlement and lands them all on the same
// URL — /plus?from=fold — but they need opposite instructions, and one of the
// splits costs money to get wrong: an Ark+-only member buying from the pricing
// cards starts a SECOND subscription, which the single-active-subscription
// guard then refuses with an "already a member" screen. The upgrade path for
// them is /account (useEntitlementOffers), not checkout.
//
// Lives here rather than beside <FoldGateNotice> so the split can be tested
// without a DOM, and so the component file stays exports-components-only for
// fast refresh.
export type FoldAudience =
  | "guest"
  | "no-membership"
  | "ark-plus-only"
  | "member";

// `null` while /api/me is still in flight: the copy differs enough between
// audiences that a flash of the wrong one is worse than a beat of nothing.
export function foldGateAudience(
  state: SubscriberAuthState,
): FoldAudience | null {
  if (state.kind === "loading") return null;
  if (state.kind === "guest") return "guest";
  // `member` here means the axis, not the session — a signed-in free user is
  // still `kind: "member"`. Reaching this branch at all means the gate's live
  // read disagreed with ours (they bought in another tab, most likely), so
  // send them back to the link rather than selling them anything.
  if (state.me.entitlements.circle) return "member";
  return state.me.entitlements.arkPlus ? "ark-plus-only" : "no-membership";
}
