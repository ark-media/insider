/// <reference types="bun" />
// Tests for the acquisition-attribution capture layer (BI plan §4.1).
//
// This is the layer that answers "where did this member come from" — a question
// the codebase previously could not answer for a single member. Two behaviors
// carry the whole design and are pinned hardest below:
//
//   1. FIRST touch is written exactly once and is never overwritten. If a later
//      visit could clobber it, "which channel introduced this member" degrades
//      into "which channel they most recently arrived from", and the number
//      stops being worth reporting.
//   2. A plain direct hit does not overwrite LAST touch. Otherwise a member who
//      arrives from a campaign and then opens a bookmark mid-session has the
//      campaign that closed the sale erased before checkout stamps Stripe.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

const g = globalThis as unknown as {
  document?: unknown;
  fetch: typeof fetch;
};
if (!g.document) {
  const realFetch = g.fetch;
  GlobalRegistrator.register();
  g.fetch = realFetch;
}

import { beforeEach, describe, expect, test } from "bun:test";
import {
  captureAttribution,
  getAttribution,
  resolveTouch,
  __resetAttributionCache,
} from "./attribution";

const NOW = "2026-07-23T12:00:00.000Z";
const SELF = "ark-plus.xyz";

const touch = (search: string, referrer = "", path = "/") =>
  resolveTouch(search, referrer, SELF, path, NOW);

describe("resolveTouch — channel resolution", () => {
  test("an explicit utm_source wins over everything else", () => {
    // The campaign told us what it is; a referrer or click id must not override.
    const t = touch(
      "?utm_source=beehiiv&utm_medium=email&utm_campaign=jul-issue&gclid=abc",
      "https://www.google.com/",
    );
    expect(t.source).toBe("beehiiv");
    expect(t.medium).toBe("email");
    expect(t.campaign).toBe("jul-issue");
  });

  test("utm_source with no utm_medium defaults the medium to referral", () => {
    expect(touch("?utm_source=partner").medium).toBe("referral");
  });

  test("a paid click id implies its source and a cpc medium", () => {
    expect(touch("?gclid=xyz")).toMatchObject({ source: "google", medium: "cpc" });
    expect(touch("?fbclid=xyz")).toMatchObject({ source: "facebook", medium: "cpc" });
    expect(touch("?msclkid=xyz")).toMatchObject({ source: "bing", medium: "cpc" });
  });

  test("?ref= — our own outbound tagging — becomes both source and campaign", () => {
    // This is the tag that turns "a podcast drove 30 signups" from a guess into
    // a number: ?ref=cmb-ep412 on a show-notes link.
    const t = touch("?ref=cmb-ep412");
    expect(t.source).toBe("cmb-ep412");
    expect(t.medium).toBe("referral");
    expect(t.campaign).toBe("cmb-ep412");
  });

  test("a search-engine referrer resolves to organic", () => {
    const t = touch("", "https://www.google.com/search?q=call+me+back");
    expect(t.source).toBe("google.com");
    expect(t.medium).toBe("organic");
  });

  test("any other external referrer resolves to referral", () => {
    const t = touch("", "https://news.ycombinator.com/item?id=1");
    expect(t.source).toBe("news.ycombinator.com");
    expect(t.medium).toBe("referral");
  });

  test("no params and no referrer is direct", () => {
    expect(touch("")).toMatchObject({ source: "direct", medium: "none" });
  });

  test("our own host as referrer is internal navigation, not acquisition", () => {
    // Includes our cross-host hand-off (checkout → ark-plus.xyz/welcome), which
    // would otherwise show up as our biggest referral source.
    expect(touch("", "https://ark-plus.xyz/plus")).toMatchObject({
      source: "direct",
      medium: "none",
    });
    expect(touch("", "https://www.ark-plus.xyz/plus").source).toBe("direct");
    expect(touch("", "https://app.ark-plus.xyz/x").source).toBe("direct");
  });

  test("a malformed referrer degrades to direct rather than throwing", () => {
    expect(touch("", "not a url").source).toBe("direct");
  });

  test("records the landing path and capture time", () => {
    const t = touch("?utm_source=x", "", "/plus");
    expect(t.landingPath).toBe("/plus");
    expect(t.at).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// Persistence. captureAttribution() reads window.location / document.referrer,
// so each case sets the URL then re-runs capture.
// ---------------------------------------------------------------------------

// happy-dom starts on about:blank, where history.replaceState leaves
// location.search empty — assigning href is what actually moves the document.
function goTo(search: string, referrer = ""): void {
  window.location.href = `https://${SELF}/${search}`;
  Object.defineProperty(document, "referrer", {
    value: referrer,
    configurable: true,
  });
  __resetAttributionCache();
}

function visit(search: string, referrer = ""): void {
  goTo(search, referrer);
  captureAttribution();
}

describe("captureAttribution — first vs last touch", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetAttributionCache();
  });

  test("the first visit writes both first- and last-touch", () => {
    visit("?utm_source=beehiiv&utm_medium=email");
    const a = getAttribution();
    expect(a.first_touch_source).toBe("beehiiv");
    expect(a.first_touch_medium).toBe("email");
    expect(a.last_touch_source).toBe("beehiiv");
  });

  test("a later campaign visit updates last-touch but NEVER first-touch", () => {
    visit("?utm_source=beehiiv&utm_medium=email");
    visit("?utm_source=twitter&utm_medium=social");

    const a = getAttribution();
    // First touch is what makes "which channel introduced this member"
    // answerable months later. It is write-once by design.
    expect(a.first_touch_source).toBe("beehiiv");
    expect(a.last_touch_source).toBe("twitter");
    expect(a.last_touch_medium).toBe("social");
  });

  test("a plain direct visit does not erase the campaign that closed the sale", () => {
    visit("?utm_source=beehiiv&utm_medium=email");
    visit(""); // e.g. opening a bookmark mid-session before checking out
    expect(getAttribution().last_touch_source).toBe("beehiiv");
  });

  test("reports whether this browser has been seen before", () => {
    goTo("");
    expect(captureAttribution()!.isReturning).toBe(false);
    __resetAttributionCache();
    expect(captureAttribution()!.isReturning).toBe(true);
  });

  test("getAttribution() reads storage directly when capture has not run", () => {
    // The checkout modals call this to stamp Stripe. It has to work even in a
    // build with no PostHog key, where nothing else touches the capture layer.
    visit("?utm_source=beehiiv&utm_medium=email");
    __resetAttributionCache();
    expect(getAttribution().first_touch_source).toBe("beehiiv");
  });

  test("survives unwritable storage instead of throwing", () => {
    // Safari private mode and hardened browser settings make setItem throw.
    // Losing attribution is acceptable; breaking the page is not.
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      __resetAttributionCache();
      expect(() => captureAttribution()).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
