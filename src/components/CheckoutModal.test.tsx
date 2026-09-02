/// <reference types="bun" />
// Covers the pay-what-you-want amount reset on the checkout email screen. Needs
// a real DOM so the render-phase adjustment actually runs, so we register
// happy-dom here. Bun's own `fetch` is preserved (happy-dom would otherwise
// replace it) so this registration can't disturb the server tests.
//
// Note on coverage: React's onChange does not fire for a plainly dispatched
// input/change event under happy-dom (the event reaches the container but
// React's change plugin drops it), so the amount tests below drive the currency
// reset through the tap-to-type toggle, which is click-driven and shares the
// same render-phase adjustment. The `customAmount` half of that reset still
// needs a manual check. `typeInto` further down does get through to onChange —
// see the note there for what it takes — if those are ever rewritten.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// CheckoutModal reads VITE_STRIPE_PUBLISHABLE_KEY at module scope — without it
// every step is replaced by a configuration error — so the key has to be set
// BEFORE the module evaluates. Hence a dynamic import rather than a static one,
// and hence its position: above the happy-dom registration below, so
// @stripe/stripe-js still imports into a document-less global and skips the
// script preload it would otherwise fire at js.stripe.com and log a failure for.
process.env.VITE_STRIPE_PUBLISHABLE_KEY ||= "pk_test_fake";
const { CheckoutModal, EmailForm } = await import("./CheckoutModal");

const g = globalThis as unknown as {
  document?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  fetch: typeof fetch;
};
if (!g.document) {
  const realFetch = g.fetch;
  GlobalRegistrator.register();
  g.fetch = realFetch;
}
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "../lib/theme";
import { SubscriberAuthProvider } from "../lib/subscriberAuth";
import { AGE_STATEMENT } from "../../shared/age-gate";

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mounted = { root, container };
  return {
    container,
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

afterEach(async () => {
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

const slider = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>('input[type="range"]');

// While the amount is being typed the hero becomes an input, so the toggle is
// absent — its presence is a proxy for "not editing".
const tapToType = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>('button[aria-label*="Tap to type"]');

const isEditing = (c: HTMLElement) => tapToType(c) === null;

function form(props: { currency: string; factor: number; floorMinor: number }) {
  return (
    <EmailForm
      plan="monthly"
      initialEmail=""
      promo={null}
      floorMinor={props.floorMinor}
      currency={props.currency}
      factor={props.factor}
      currencies={["usd", "jpy"]}
      onCurrencyChange={() => {}}
      onSubmit={() => {}}
    />
  );
}

const usd = { currency: "usd", factor: 100, floorMinor: 500 };
// JPY is zero-decimal, so it formats and scales differently from USD.
const jpy = { currency: "jpy", factor: 1, floorMinor: 500 };

describe("CheckoutModal amount selection", () => {
  test("starts at the floor for the given currency", async () => {
    const { container } = await render(form(usd));
    expect(slider(container)?.getAttribute("aria-valuetext")).toContain("$5");
    expect(isEditing(container)).toBe(false);
  });

  test("switching currency re-renders the amount in the new currency", async () => {
    const { container, rerender } = await render(form(usd));
    const before = slider(container)?.getAttribute("aria-valuetext");
    expect(before).toContain("$5");

    await rerender(form(jpy));
    const after = slider(container)?.getAttribute("aria-valuetext");
    expect(after).not.toBe(before);
    expect(after).not.toContain("$5");
  });

  // The reset is applied during render via a prevCurrency sentinel rather than
  // in an effect. This is the half of it that a click can reach.
  test("switching currency closes the tap-to-type editor", async () => {
    const { container, rerender } = await render(form(usd));
    expect(isEditing(container)).toBe(false);

    await act(async () => {
      tapToType(container)?.click();
    });
    expect(isEditing(container)).toBe(true);

    await rerender(form(jpy));
    expect(isEditing(container)).toBe(false);
  });

  // Guards the other direction: the sentinel must not fire on every render, or
  // the editor would slam shut on any unrelated parent update.
  test("re-rendering with the same currency leaves the editor open", async () => {
    const { container, rerender } = await render(form(usd));

    await act(async () => {
      tapToType(container)?.click();
    });
    expect(isEditing(container)).toBe(true);

    await rerender(form(usd));
    expect(isEditing(container)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Community 18+ gate
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> | null };

let fetchCalls: FetchCall[] = [];
let realFetch: typeof fetch;

// The modal fetches its promo and its per-currency pricing on open, then posts
// to create-checkout-session on submit. Stub all three so nothing leaves the
// process and the POST body is inspectable.
function stubFetch() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    fetchCalls.push({ url, body });
    if (url.startsWith("/api/pricing")) {
      return Response.json({
        tiers: {
          "ark-plus": { monthly: { usd: 800 }, yearly: { usd: 8000 } },
          circle: { monthly: { usd: 900 }, yearly: { usd: 9000 } },
          bundle: { monthly: { usd: 1200 }, yearly: { usd: 12000 } },
        },
        currencies: ["usd"],
        minor_factors: { usd: 100 },
        default_currency: "usd",
      });
    }
    if (url.startsWith("/api/promo/active")) return Response.json({ active: false });
    if (url.startsWith("/api/stripe/create-checkout-session")) {
      return Response.json({
        client_secret: "cs_test_secret",
        checkout_session_id: "cs_test_1",
      });
    }
    return Response.json({});
  }) as typeof fetch;
}

async function openModal(tier: "ark-plus" | "circle" | "bundle") {
  return render(
    <ThemeProvider>
      <SubscriberAuthProvider>
        <CheckoutModal open plan="monthly" tier={tier} onClose={() => {}} />
      </SubscriberAuthProvider>
    </ThemeProvider>,
  );
}

// The modal renders into a Modal panel appended to document.body, not into the
// container the root owns, so queries run against the document.
const text = () => document.body.textContent ?? "";
const emailInput = () =>
  document.body.querySelector<HTMLInputElement>('input[type="email"]');
const ageCheckbox = () =>
  document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
const buttonWith = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );

// Types into a controlled text input. Two things are load-bearing and neither
// is obvious:
//
//   1. The value is written through the PROTOTYPE setter. React redefines
//      `value` on the node to track the last value it knows about; assigning
//      `input.value = …` goes through that and leaves React thinking nothing
//      changed.
//   2. The event is a focus + `keyup`, not an `input`. Under happy-dom React's
//      feature detection falls back to its legacy change path, which fires
//      onChange off the focused element on key events — a bare `input` event
//      reaches the container and is dropped. This is the gap the file header
//      notes; this is the way through it.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  input.focus();
  setter?.call(input, value);
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "o" }));
}

describe("CheckoutModal community 18+ gate", () => {
  beforeEach(() => {
    fetchCalls = [];
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("ark-plus opens straight on the email form", async () => {
    await openModal("ark-plus");
    expect(text()).not.toContain(AGE_STATEMENT);
    expect(emailInput()).not.toBeNull();
  });

  for (const tier of ["circle", "bundle"] as const) {
    test(`${tier} opens on the age gate, ahead of the email form`, async () => {
      await openModal(tier);
      expect(text()).toContain(AGE_STATEMENT);
      // The point of the gate is that nothing else is reachable behind it.
      expect(emailInput()).toBeNull();
    });
  }

  test("the box starts unticked and continue is disabled until it is ticked", async () => {
    await openModal("bundle");
    const box = ageCheckbox();
    expect(box?.checked).toBe(false);
    expect(buttonWith("Continue")?.disabled).toBe(true);

    await act(async () => {
      box?.click();
    });
    expect(buttonWith("Continue")?.disabled).toBe(false);
  });

  test("confirming advances to the email form", async () => {
    await openModal("bundle");
    await act(async () => ageCheckbox()?.click());
    await act(async () => buttonWith("Continue")?.click());
    expect(text()).not.toContain(AGE_STATEMENT);
    expect(emailInput()).not.toBeNull();
  });

  test("the create-checkout-session body carries age_confirmed", async () => {
    await openModal("bundle");
    await act(async () => ageCheckbox()?.click());
    await act(async () => buttonWith("Continue")?.click());

    const input = emailInput();
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input!, "buyer@example.com");
    });
    await act(async () => {
      input!.form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    const post = fetchCalls.find((c) =>
      c.url.startsWith("/api/stripe/create-checkout-session"),
    );
    expect(post?.body?.age_confirmed).toBe(true);
    expect(post?.body?.tier).toBe("bundle");
  });

  test("declining the bundle continues as Ark+ with no confirmation", async () => {
    await openModal("bundle");
    await act(async () => {
      buttonWith("continue with Ark+ only")?.click();
    });
    // A real product, minus the part with the age requirement — not a dead end,
    // and the swap is stated rather than left to be inferred from the price.
    expect(emailInput()).not.toBeNull();
    expect(text()).toContain("Ark+ Membership");
    expect(text()).toContain("Community access is 18+");

    const input = emailInput();
    await act(async () => typeInto(input!, "buyer@example.com"));
    await act(async () => {
      input!.form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const post = fetchCalls.find((c) =>
      c.url.startsWith("/api/stripe/create-checkout-session"),
    );
    expect(post?.body?.tier).toBe("ark-plus");
    expect(post?.body?.age_confirmed).toBe(false);
  });

  test("declining standalone Community stops with an explanation", async () => {
    await openModal("circle");
    await act(async () => {
      buttonWith("I'm under 18")?.click();
    });
    expect(text()).toContain("Community access is 18+");
    expect(emailInput()).toBeNull();
  });
});
