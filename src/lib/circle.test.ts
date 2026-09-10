/// <reference types="bun" />
// The v1 subscriber-feed read functions. After dropping the mock fallback these
// hit their /api/circle/* endpoints and THROW on failure (so /fold can show
// an error+retry). These tests stub global fetch to cover both paths: a 200
// response is passed through (preserving the CommunityFeedItem / SuggestedSpace
// contract), and a failure rejects rather than silently degrading.

import { describe, test, expect, afterEach } from "bun:test";
import {
  circleAppDownloads,
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

describe("circleAppDownloads", () => {
  const realNavigator = globalThis.navigator;
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
    });
  });

  function stubNavigator(userAgent: string, maxTouchPoints = 0) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent, maxTouchPoints },
      configurable: true,
    });
  }

  const platforms = () => circleAppDownloads().map((d) => d.platform);

  test("offers only the App Store on an iPhone", () => {
    stubNavigator(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
    );
    expect(platforms()).toEqual(["ios"]);
  });

  test("offers only Google Play on Android", () => {
    stubNavigator("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36");
    expect(platforms()).toEqual(["android"]);
  });

  // iPadOS 13+ claims to be a Mac; touch points are what give it away.
  test("treats a touch 'Macintosh' as an iPad", () => {
    stubNavigator("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5);
    expect(platforms()).toEqual(["ios"]);
  });

  test("offers both from a desktop browser, which tells us nothing", () => {
    stubNavigator("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140");
    expect(platforms()).toEqual(["ios", "android"]);
  });

  test("carries the real store URLs", () => {
    stubNavigator("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(circleAppDownloads().map((d) => d.href)).toEqual([
      "https://apps.apple.com/us/app/the-ark-media-community/id6775856136",
      "https://play.google.com/store/apps/details?id=org.arkmedia.app",
    ]);
  });
});
