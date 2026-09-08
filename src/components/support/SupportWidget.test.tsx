/// <reference types="bun" />
// The widget shell: it is a disclosure, not a modal, and it must stay out of
// the way of everything else on the page.
//
// Not tested here: typing into the search box. happy-dom doesn't drive React's
// onChange from a synthetic input event (see the note in CheckoutModal.test.tsx)
// and search quality has its own suite anyway — src/lib/support/search.test.ts
// covers 75 ranking cases against the real corpus without a DOM at all.
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
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { SubscriberAuthProvider } from "../../lib/subscriberAuth";
import { resetSupportSession } from "../../lib/support/session";
import { SupportWidget } from "./SupportWidget";
import type { Faq } from "../../lib/faqs";

const faq = (over: Partial<Faq> = {}): Faq => ({
  id: "faq-1",
  key: "cancel-anytime",
  question: "Can I cancel my subscription at any time?",
  answer: "<p>Yes. Cancel whenever you like.</p>",
  category: "Account & Billing",
  enabled: true,
  displayOrder: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

let faqsStatus = 200;

function stubFetch() {
  g.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/faqs")) {
      if (faqsStatus !== 200) return new Response("nope", { status: faqsStatus });
      return Response.json({ faqs: [faq()] });
    }
    if (url.startsWith("/api/support/log")) return Response.json({ ok: true });
    return Response.json({});
  }) as typeof fetch;
}

// --- harness ---------------------------------------------------------------
// A two-route memory router, because the widget reads the pathname to suppress
// itself on /admin/* and navigates on escalation. `as never` on the provider:
// src/router.tsx registers the real app router's type, and a test router built
// from a different route tree can't satisfy it.

function buildRouter(initial: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <SubscriberAuthProvider>
        <Outlet />
        <SupportWidget />
      </SubscriberAuthProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <main>home</main>,
  });
  const contactRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/contact",
    component: () => <main>contact form</main>,
  });
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/faqs",
    component: () => <main>back office</main>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, contactRoute, adminRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
}

let mounted: { root: Root; container: HTMLElement } | null = null;
let router: ReturnType<typeof buildRouter>;

async function mount(initial = "/") {
  router = buildRouter(initial);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<RouterProvider router={router as never} />);
  });
  await settle();
  mounted = { root, container };
}

/** Let the lazy panel chunk, its Suspense boundary and the FAQ fetch resolve. */
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  faqsStatus = 200;
  resetSupportSession();
  stubFetch();
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  resetSupportSession();
  g.fetch = realFetch;
});

const text = () => document.body.textContent ?? "";
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const buttonWith = (label: string) =>
  buttons().find((b) => (b.textContent ?? "").includes(label));
const launcher = () =>
  document.body.querySelector<HTMLButtonElement>('[aria-controls="support-panel"]')!;
const panel = () => document.body.querySelector<HTMLElement>("#support-panel");

async function click(el: HTMLElement | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.click();
  });
  await settle();
}

async function open() {
  await click(launcher());
}

// --- tests -----------------------------------------------------------------

describe("launcher", () => {
  test("renders closed, and costs nothing until it is opened", async () => {
    await mount();
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    // The panel isn't in the DOM at all, so neither is the FAQ fetch it makes.
    expect(panel()).toBeNull();
    expect(text()).toContain("Help");
  });

  test("is suppressed in the back office", async () => {
    await mount("/admin/faqs");
    expect(document.body.querySelector('[aria-controls="support-panel"]')).toBeNull();
  });
});

describe("open and close", () => {
  test("opening reveals the topics without waiting for the answers", async () => {
    await mount();
    await open();
    expect(launcher().getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Cancel or change my plan");
  });

  test("Escape closes it and the panel goes inert", async () => {
    await mount();
    await open();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    // Still mounted — it keeps the fetched index and the member's place in it —
    // but out of the tab order and the accessibility tree.
    expect(panel()?.hasAttribute("inert")).toBe(true);
  });

  test("reopening does not re-fetch the answers", async () => {
    await mount();
    await open();
    let faqCalls = 0;
    const inner = g.fetch;
    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/faqs")) faqCalls += 1;
      return inner(input, init);
    }) as typeof fetch;

    await click(buttonWith("Close"));
    await open();
    expect(faqCalls).toBe(0);
  });
});

describe("topics", () => {
  test("a chip opens its topic, with a way back", async () => {
    await mount();
    await open();
    await click(buttonWith("Cancel or change my plan"));

    expect(text()).toContain("Cancel, switch billing period");
    await click(buttonWith("All topics"));
    expect(text()).toContain("Search the answers, or pick a topic.");
  });

  test("a signed-out visitor is told about Apple instead of being sent to an account page", async () => {
    // The whole point of the fork: an Apple subscriber has no login here and
    // reads as a guest, and /account/billing would bounce them to /plus.
    await mount();
    await open();
    await click(buttonWith("Cancel or change my plan"));

    expect(text()).toContain("subscribed through Apple Podcasts");
    const hrefs = [...document.body.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.startsWith("/account"))).toBe(false);
  });
});

describe("escalation", () => {
  test("hands off to /contact with the desk chosen and a transcript stashed", async () => {
    await mount();
    await open();
    await click(buttonWith("Cancel or change my plan"));
    await click(buttonWith("Talk to a person"));

    expect(router.state.location.pathname).toBe("/contact");
    expect(router.state.location.search).toMatchObject({ topic: "support" });

    const raw = window.sessionStorage.getItem("ark.support.draft");
    expect(raw).toBeTruthy();
    const draft = JSON.parse(raw!) as { topic: string; message: string };
    expect(draft.topic).toBe("support");
    expect(draft.message).toContain("Cancel or change my plan");

    // And it closes behind itself, rather than floating over the form.
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("when the answers can't be loaded", () => {
  test("the topics and the escalation still work", async () => {
    faqsStatus = 500;
    await mount();
    await open();

    expect(text()).toContain("didn’t load");
    expect(buttonWith("Try again")).toBeTruthy();
    // The half that never needed the FAQ data is untouched.
    expect(buttonWith("Cancel or change my plan")).toBeTruthy();
    expect(buttonWith("Talk to a person")).toBeTruthy();
  });
});
