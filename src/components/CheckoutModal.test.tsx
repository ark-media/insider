/// <reference types="bun" />
// Covers the pay-what-you-want amount reset on the checkout email screen. Needs
// a real DOM so the render-phase adjustment actually runs, so we register
// happy-dom here. Bun's own `fetch` is preserved (happy-dom would otherwise
// replace it) so this registration can't disturb the server tests.
//
// Note on coverage: React's onChange does not fire for synthetically dispatched
// input/change events under happy-dom (the event reaches the container but
// React's change plugin ignores it), so the slider and the typed-amount field
// can't be driven from here. These tests exercise the currency reset through
// the tap-to-type toggle, which is click-driven and shares the same render-phase
// adjustment. The `customAmount` half of that reset still needs a manual check.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmailForm } from "./CheckoutModal";

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
