/// <reference types="bun" />
// Behavioral tests for the Toast. Unlike the repo's static-markup tests, these
// need a real DOM so effects, timers, and clicks actually run — so we register
// happy-dom here. We keep Bun's own `fetch` (happy-dom would otherwise replace
// it) so this registration can't disturb the fetch-based server tests.
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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toast } from "./Toast";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Toast plays a 300ms exit transition before calling onDismiss; tests that
// expect dismissal wait past that.
const EXIT_MS = 300;

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

afterEach(async () => {
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

describe("Toast", () => {
  test("renders the message as a polite status with a dismiss control", async () => {
    const onDismiss = mock();
    const container = await render(
      <Toast message="Gift sent — link emailed." onDismiss={onDismiss} duration={10_000} />,
    );

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Gift sent — link emailed.");
    expect(container.querySelector('button[aria-label="Dismiss"]')).not.toBeNull();
    // It must not dismiss itself just by mounting.
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("auto-dismisses once the duration elapses", async () => {
    const onDismiss = mock();
    await render(<Toast message="Done." onDismiss={onDismiss} duration={20} />);

    expect(onDismiss).not.toHaveBeenCalled();
    // First let the duration timer fire and commit the exit state (which arms
    // the 300ms unmount timer), then wait out that exit transition.
    await act(async () => {
      await sleep(60);
    });
    await act(async () => {
      await sleep(EXIT_MS + 80);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("dismisses when the close button is clicked", async () => {
    const onDismiss = mock();
    const container = await render(
      <Toast message="Done." onDismiss={onDismiss} duration={10_000} />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss"]',
    );
    await act(async () => {
      button?.click();
    });
    // The exit transition hasn't finished yet, so it shouldn't have fired.
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => {
      await sleep(EXIT_MS + 80);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
