/// <reference types="bun" />
// The store-link picker: which app store to put in front of this visitor,
// decided from the user agent alone.

import { describe, test, expect, afterEach } from "bun:test";
import { circleAppDownloads } from "./circle";

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
