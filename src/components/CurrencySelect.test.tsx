/// <reference types="bun" />
// Behavioral tests for the CurrencySelect listbox: keyboard (incl. type-ahead)
// and the ARIA wiring screen readers depend on. Needs a real DOM, so happy-dom
// is registered here, keeping Bun's own `fetch` for the server tests.
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

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CurrencySelect } from "./CurrencySelect";

const OPTIONS = ["usd", "gbp", "eur", "cad", "sek", "sgd", "chf"];

let mounted: { root: Root; container: HTMLElement } | null = null;

// A controlled wrapper so a commit actually changes the trigger's value.
function Harness({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState("gbp");
  return (
    <CurrencySelect
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

async function render(onChange = mock((_: string) => {})) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness onChange={onChange} />);
  });
  mounted = { root, container };
  return { container, onChange };
}

afterEach(async () => {
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

const trigger = (c: HTMLElement) => c.querySelector("button") as HTMLButtonElement;
const listbox = (c: HTMLElement) => c.querySelector('[role="listbox"]') as HTMLElement | null;
const activeOption = (c: HTMLElement) => {
  const id = listbox(c)?.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}

describe("CurrencySelect", () => {
  test("the open list is named and wired to its trigger", async () => {
    const { container } = await render();
    await key(trigger(container), "Enter");
    const list = listbox(container)!;
    expect(list.getAttribute("aria-label")).toBe("Currency");
    expect(trigger(container).getAttribute("aria-controls")).toBe(list.id);
    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
  });

  test("options carry the currency name, not just the code", async () => {
    const { container } = await render();
    await key(trigger(container), "Enter");
    const gbp = [...container.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent === "GBP",
    )!;
    expect(gbp.getAttribute("aria-label")).toBe("GBP, British Pound");
    expect(gbp.getAttribute("aria-selected")).toBe("true");
  });

  test("typing a code in the open list jumps to it", async () => {
    const { container } = await render();
    await key(trigger(container), "Enter");
    for (const k of "usd") await key(listbox(container)!, k);
    expect(activeOption(container)?.textContent).toBe("USD");
  });

  test("typing a currency name matches too", async () => {
    const { container } = await render();
    await key(trigger(container), "Enter");
    for (const k of "swiss") await key(listbox(container)!, k);
    expect(activeOption(container)?.textContent).toBe("CHF");
  });

  test("repeating one letter cycles through its matches", async () => {
    const { container } = await render();
    await key(trigger(container), "Enter");
    await key(listbox(container)!, "s");
    const first = activeOption(container)?.textContent;
    await key(listbox(container)!, "s");
    const second = activeOption(container)?.textContent;
    expect(first).not.toBe(second);
    expect(["SEK", "SGD", "CHF"]).toContain(first!);
    expect(["SEK", "SGD", "CHF"]).toContain(second!);
  });

  test("typing on the closed trigger opens the list at the match, Enter commits", async () => {
    const { container, onChange } = await render();
    await key(trigger(container), "e");
    expect(listbox(container)).not.toBeNull();
    expect(activeOption(container)?.textContent).toBe("EUR");
    await key(listbox(container)!, "Enter");
    expect(onChange).toHaveBeenCalledWith("eur");
    expect(listbox(container)).toBeNull();
    expect(trigger(container).getAttribute("aria-label")).toBe("Currency: EUR");
  });

  test("no match leaves the active option where it was", async () => {
    const { container } = await render();
    await key(trigger(container), "Enter");
    await key(listbox(container)!, "z");
    expect(activeOption(container)?.textContent).toBe("GBP");
  });
});
