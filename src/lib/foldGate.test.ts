/// <reference types="bun" />
// Which of the four things the Fold-gate notice says, given the session.
//
// The Auth0 Action bounces two very different people to /plus?from=fold with
// the same URL, and the one that costs money to get wrong is the Ark+-only
// member: sending them to the pricing cards starts a second subscription the
// single-active-subscription guard then refuses. So the split is pinned here
// rather than left to the component's JSX.
import { describe, expect, test } from "bun:test";
import { foldGateAudience } from "./foldGate";
import type { SubscriberAuthState } from "./subscriberAuth";
import type { Me } from "./auth";

function member(entitlements: { arkPlus: boolean; circle: boolean }) {
  return {
    kind: "member",
    me: { email: "m@example.com", tier: "free", entitlements, feeds: [] } as Me,
  } satisfies SubscriberAuthState;
}

describe("foldGateAudience", () => {
  test("says nothing until /api/me resolves", () => {
    expect(foldGateAudience({ kind: "loading" })).toBeNull();
  });

  test("a signed-out visitor is asked to sign in", () => {
    expect(foldGateAudience({ kind: "guest" })).toBe("guest");
  });

  // A signed-in free user is still `kind: "member"` — the entitlement, not the
  // session, is what decides here.
  test("a signed-in account with no axes is sold a membership", () => {
    expect(foldGateAudience(member({ arkPlus: false, circle: false }))).toBe(
      "no-membership",
    );
  });

  test("an Ark+-only member is sent to their account, not to checkout", () => {
    expect(foldGateAudience(member({ arkPlus: true, circle: false }))).toBe(
      "ark-plus-only",
    );
  });

  test("someone who does hold the axis is sent back to the Fold", () => {
    expect(foldGateAudience(member({ arkPlus: false, circle: true }))).toBe(
      "member",
    );
    expect(foldGateAudience(member({ arkPlus: true, circle: true }))).toBe(
      "member",
    );
  });
});
