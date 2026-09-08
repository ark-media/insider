/// <reference types="bun" />
// The v1 subscriber-feed read functions. After dropping the mock fallback these
// hit their /api/circle/* endpoints and THROW on failure (so /community can show
// an error+retry). These tests stub global fetch to cover both paths: a 200
// response is passed through (preserving the CommunityFeedItem / SuggestedSpace
// contract), and a failure rejects rather than silently degrading.

import { describe, test, expect, afterEach } from "bun:test";
import {
  fetchActivityDigest,
  fetchCommunityFeed,
  fetchSuggestedSpaces,
} from "./circle";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: Request | string | URL) =>
    Promise.resolve(impl(String(input)))) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchCommunityFeed", () => {
  test("returns the endpoint's items on success", async () => {
    const item = {
      id: "p1",
      authorName: "Dan Senor",
      authorRole: "Host",
      publishedAt: "2026-05-01T00:00:00.000Z",
      excerpt: "A preview line.",
      href: "https://thefold.arkmedia.org/c/conversation/p1",
    };
    stubFetch(() => jsonResponse({ items: [item] }));

    const items = await fetchCommunityFeed();
    expect(items).toEqual([item]);
  });

  test("honors a reachable-but-empty response", async () => {
    stubFetch(() => jsonResponse({}));
    expect(await fetchCommunityFeed()).toEqual([]);
  });

  test("rejects on a non-2xx response", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    await expect(fetchCommunityFeed()).rejects.toThrow();
  });

  test("rejects on a network error", async () => {
    stubFetch(() => {
      throw new Error("offline");
    });
    await expect(fetchCommunityFeed()).rejects.toThrow();
  });
});

describe("fetchSuggestedSpaces", () => {
  test("returns the endpoint's spaces on success", async () => {
    const space = {
      id: "call-me-back",
      name: "Inside Call Me Back",
      description: "The room around the flagship show.",
      memberCount: 4120,
      href: "https://thefold.arkmedia.org/c/call-me-back",
    };
    stubFetch(() => jsonResponse({ spaces: [space] }));
    expect(await fetchSuggestedSpaces()).toEqual([space]);
  });

  test("rejects on failure", async () => {
    stubFetch(() => new Response("nope", { status: 503 }));
    await expect(fetchSuggestedSpaces()).rejects.toThrow();
  });
});

describe("fetchActivityDigest", () => {
  test("returns null in v1 (no per-member reads yet)", async () => {
    expect(await fetchActivityDigest()).toBeNull();
  });
});
