// The one place the help widget learns who it is talking to.
//
// Everything downstream takes a `SupportViewer` — a four-boolean snapshot with
// no `tier` field — so the house rule (gate on entitlements, never on tier) is
// enforced by the shape of the data rather than by remembering to follow it.

import {
  isArkPlusMember,
  isCircleMember,
  type SubscriberAuthState,
} from "../subscriberAuth";
import type { SupportViewer } from "../../data/supportTopics";

/**
 * `loading` collapses to the guest view. The widget renders the moment it is
 * opened and must not blank out while /api/me resolves; a guest-shaped panel
 * that gains an account link a beat later is the mild failure, and the panel
 * cannot be opened before the root layout has already resolved auth anyway.
 */
export function viewerFrom(state: SubscriberAuthState): SupportViewer {
  const signedIn = state.kind === "member";
  const arkPlus = isArkPlusMember(state);
  const circle = isCircleMember(state);
  return { signedIn, arkPlus, circle, free: signedIn && !arkPlus && !circle };
}
