/// <reference types="bun" />
// The Settings tab's email rows.
//
// The thing under test is not the toggling — it is that the two switches do not
// pretend to be independent. Both newsletters live in ONE Beehiiv publication:
// `free` is "subscribed at all" and `premium` is "holds the paid tier within
// that subscription", so turning `free` off deactivates the whole record and
// the members-only letter stops with it.
//
// Rendered as two free-standing toggles, that shipped as a way for a paying
// member to silently cancel the newsletter they pay for while the UI went on
// reporting it as On.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const g = globalThis as unknown as {
  document?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  fetch: typeof fetch;
};
const realFetch = g.fetch;
if (!g.document) {
  GlobalRegistrator.register();
  g.fetch = realFetch;
}
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmailPreferences } from "./EmailPreferences";
import type { NewsletterPrefs } from "../../lib/newsletterPrefs";

// --- fetch stub -------------------------------------------------------------
// The real fetchNewsletterPrefs/saveNewsletterPrefs stay in the path; only the
// endpoint is stubbed. `puts` records the exact body sent, which is where the
// destructive version of this component gave itself away.
let prefs: NewsletterPrefs;
let puts: Array<Record<string, unknown>> = [];

function stubFetch() {
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith("/api/me/newsletters")) return Response.json({});
    if ((init?.method ?? "GET") === "GET") return Response.json(prefs);

    const body = JSON.parse(String(init?.body ?? "{}")) as Partial<NewsletterPrefs>;
    puts.push(body);
    // Mirror the server: `free:false` unsubscribes the whole record, and the
    // premium TIER survives that — which is precisely why the UI cannot read
    // `premium` alone and call it delivery.
    if (typeof body.free === "boolean") prefs = { ...prefs, free: body.free };
    if (typeof body.premium === "boolean") prefs = { ...prefs, premium: body.premium };
    return Response.json(prefs);
  }) as typeof fetch;
}

// --- render harness ---------------------------------------------------------
let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mounted = { root, container };
  return container;
}

beforeEach(() => {
  puts = [];
  stubFetch();
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  g.fetch = realFetch;
});

/** The ON/OFF switch for a row, found by its accessible name. */
function toggle(title: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("[role=switch]")].find(
    (b) => (b.getAttribute("aria-label") ?? "").startsWith(title),
  );
  if (!found) throw new Error(`no switch for "${title}"`);
  return found;
}

const DAILY = "Ark News Daily";
const LETTER = "Members-only newsletter";

const on = (title: string) => toggle(title).getAttribute("aria-checked") === "true";
const click = async (title: string) => {
  await act(async () => {
    toggle(title).click();
  });
};

async function mount(over: Partial<NewsletterPrefs> = {}) {
  prefs = { free: true, premium: true, canPremium: true, ...over };
  await render(<EmailPreferences email="member@example.com" />);
}

describe("a member entitled to the members letter", () => {
  test("sees both rows, and both read as delivered", async () => {
    await mount();
    expect(on(DAILY)).toBe(true);
    expect(on(LETTER)).toBe(true);
  });

  test("turning the daily off does not leave the letter claiming to be On", async () => {
    // The bug: `free:false` deactivates the whole Beehiiv record, but the tier
    // assignment survives, so the response still reports premium:true. Reading
    // that field as delivery rendered "On" over a newsletter that had just
    // stopped arriving.
    await mount();
    await click(DAILY);

    expect(puts).toEqual([{ free: false }]);
    expect(on(DAILY)).toBe(false);
    expect(on(LETTER)).toBe(false);
  });

  test("the daily row says what turning it off actually costs", async () => {
    await mount();
    expect(document.body.textContent).toContain(
      "stops all Ark Media newsletters, including the members-only one",
    );
  });

  test("turning the letter back on from an unsubscribed record re-subscribes", async () => {
    // Setting the tier on a deactivated record would light the switch and
    // deliver nothing, so the patch has to carry `free` back with it.
    await mount({ free: false, premium: true });
    expect(on(LETTER)).toBe(false);

    await click(LETTER);
    expect(puts).toEqual([{ free: true, premium: true }]);
    expect(on(LETTER)).toBe(true);
    expect(on(DAILY)).toBe(true);
  });

  test("turning the letter off leaves the daily alone", async () => {
    await mount();
    await click(LETTER);

    expect(puts).toEqual([{ premium: false }]);
    expect(on(LETTER)).toBe(false);
    expect(on(DAILY)).toBe(true);
  });
});

describe("a reader with no entitlement", () => {
  test("gets one row — a switch they can't flip is not a switch", async () => {
    await mount({ canPremium: false, premium: false });
    expect(document.body.textContent).not.toContain(LETTER);
    expect(on(DAILY)).toBe(true);
  });

  test("has no members-letter warning on the daily row", async () => {
    await mount({ canPremium: false, premium: false });
    expect(document.body.textContent).not.toContain("including the members-only one");
    expect(document.body.textContent).toContain("Every weekday morning.");
  });
});
