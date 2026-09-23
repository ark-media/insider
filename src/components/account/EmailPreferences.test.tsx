/// <reference types="bun" />
// The Settings tab's email section.
//
// One newsletter, one switch. Which edition arrives (free or members') is the
// Beehiiv premium tier, which the membership owns — so the switch only ever
// sends `free`, and a reader can never drop an Ark+ member's premium tier
// (their edition and their private-feed grant) from here.
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

const NEWSLETTER = "The Ark Media Newsletter";

/** The newsletter's subscribe/unsubscribe button. */
function button(): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.getAttribute("aria-label") ?? "").endsWith(NEWSLETTER),
  );
  if (!found) throw new Error(`no button for "${NEWSLETTER}"`);
  return found;
}

const label = () => button().textContent;
const on = () => label() === "Unsubscribe";
const click = async () => {
  await act(async () => {
    button().click();
  });
};

async function mount(over: Partial<NewsletterPrefs> = {}) {
  prefs = { free: true, premium: true, canPremium: true, ...over };
  await render(<EmailPreferences email="member@example.com" />);
}

test("a subscribed reader is offered Unsubscribe, and told they're subscribed", async () => {
  await mount();
  expect(label()).toBe("Unsubscribe");
  expect(button().getAttribute("aria-label")).toBe(`Unsubscribe from ${NEWSLETTER}`);
  expect(document.body.textContent).toContain("Subscribed");
});

test("an unsubscribed reader is offered Subscribe", async () => {
  await mount({ free: false });
  expect(label()).toBe("Subscribe");
  expect(document.body.textContent).toContain("Not subscribed");
});

describe("an Ark+ member", () => {
  test("is told they get the members' edition", async () => {
    await mount();
    expect(on()).toBe(true);
    expect(document.body.textContent).toContain("You get the members' edition");
  });

  test("turning it off sends only `free` — the tier is left alone", async () => {
    await mount();
    await click();
    expect(puts).toEqual([{ free: false }]);
    expect(on()).toBe(false);
  });

  test("turning it back on sends only `free`", async () => {
    // The server re-applies the member's edition on re-subscribe; the client
    // has no say in the tier.
    await mount({ free: false });
    await click();
    expect(puts).toEqual([{ free: true }]);
    expect(on()).toBe(true);
  });
});

describe("a free reader", () => {
  test("is told they get the free edition", async () => {
    await mount({ canPremium: false, premium: false });
    expect(on()).toBe(true);
    expect(document.body.textContent).toContain("The free edition");
    expect(document.body.textContent).not.toContain("You get the members' edition");
  });
});
