/// <reference types="bun" />
// The v1 subscriber-feed read functions. These guard the v1→v2 data contract:
// the projection must expose only preview fields (no raw CommunityBroadcast
// body/visibility leaking through), the digest must be null in v1, and the
// empty-state spaces must be non-empty.

import { describe, test, expect } from "bun:test";
import {
  fetchActivityDigest,
  fetchCommunityFeed,
  fetchSuggestedSpaces,
} from "./circle";
import { communityBroadcasts } from "../data/communityBroadcasts";

describe("fetchCommunityFeed", () => {
  test("projects every broadcast into the CommunityFeedItem shape", async () => {
    const items = await fetchCommunityFeed();
    expect(items.length).toBe(communityBroadcasts.length);

    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ["authorName", "authorRole", "excerpt", "href", "id", "publishedAt"].sort(),
      );
    }
  });

  test("does not leak raw broadcast fields (body, visibility)", async () => {
    const items = await fetchCommunityFeed();
    for (const item of items) {
      expect(item).not.toHaveProperty("body");
      expect(item).not.toHaveProperty("visibility");
    }
  });

  test("preview fields and a deep link are carried through", async () => {
    const items = await fetchCommunityFeed();
    const first = items[0]!;
    const source = communityBroadcasts[0]!;
    expect(first.id).toBe(source.id);
    expect(first.excerpt).toBe(source.excerpt);
    // Read-only: actions deep-link into the app via the circle-sso bridge.
    expect(first.href).toContain("/circle-sso");
  });
});

describe("fetchActivityDigest", () => {
  test("returns null in v1 (no per-member reads yet)", async () => {
    expect(await fetchActivityDigest()).toBeNull();
  });
});

describe("fetchSuggestedSpaces", () => {
  test("returns a non-empty list, each with a deep link", async () => {
    const spaces = await fetchSuggestedSpaces();
    expect(spaces.length).toBeGreaterThan(0);
    for (const space of spaces) {
      expect(space.href).toContain("/circle-sso");
      expect(space.memberCount).toBeGreaterThan(0);
    }
  });
});
