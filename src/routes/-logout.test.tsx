/// <reference types="bun" />
// /logout must not be a forced-logout gadget. The server refuses a cross-site
// request to /api/auth/logout, but a cross-site LINK to this page is only a page
// load — and the sign-out this page then fires is same-origin. So what's pinned
// here is that the automatic sign-out needs proof the visit began inside the
// app, and that everyone else gets a button rather than a silent logout.
//
// (Filename starts with `-` so TanStack's route generator ignores it; without
// the prefix a file in src/routes becomes a route.)
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

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ORIGIN = "https://ark-plus.xyz";

const { Route } = await import("./logout");
const { SubscriberAuthProvider } = await import("../lib/subscriberAuth");
const Logout = Route.options.component as React.ComponentType;

// The real provider's signOut() is `window.location.assign('/api/auth/logout')`.
// Spying on that — rather than mocking the auth module, which is process-wide —
// keeps the assertion on the thing that actually ends the session.
let assign: ReturnType<typeof spyOn>;
let navEntries: ReturnType<typeof spyOn>;

function arriveWith(opts: { loadedAt?: string; referrer?: string }) {
  navEntries = spyOn(performance, "getEntriesByType").mockImplementation(((type: string) =>
    type === "navigation" && opts.loadedAt
      ? [{ name: `${ORIGIN}${opts.loadedAt}` }]
      : []) as typeof performance.getEntriesByType);
  Object.defineProperty(document, "referrer", {
    configurable: true,
    get: () => opts.referrer ?? "",
  });
}

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SubscriberAuthProvider>
        <Logout />
      </SubscriberAuthProvider>,
    );
  });
  mounted = { root, container };
  return container;
}

const signOutButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sign out");

const setURL = (url: string) =>
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);

beforeEach(() => {
  setURL(`${ORIGIN}/logout`);
  assign = spyOn(window.location, "assign").mockImplementation(mock());
});

afterEach(async () => {
  assign.mockRestore();
  navEntries.mockRestore();
  // The happy-dom window is shared by every suite in the process, and others
  // rely on it being the pathless about:blank (see subscriberAuth.test).
  delete (document as unknown as { referrer?: string }).referrer;
  setURL("about:blank");
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

describe("/logout", () => {
  test("a cross-site link does NOT sign the member out — it asks", async () => {
    arriveWith({ loadedAt: "/logout", referrer: "https://evil.example/post" });
    const container = await render();

    expect(assign).not.toHaveBeenCalled();
    expect(signOutButton(container)).toBeDefined();
    expect(container.textContent).not.toContain("Signing out");
  });

  test("no referrer at all (typed URL, email client, no-referrer link) also asks", async () => {
    arriveWith({ loadedAt: "/logout" });
    const container = await render();

    expect(assign).not.toHaveBeenCalled();
    expect(signOutButton(container)).toBeDefined();
  });

  test("a look-alike origin in the referrer is not ours", async () => {
    arriveWith({ loadedAt: "/logout", referrer: `${ORIGIN}.evil.example/` });
    await render();
    expect(assign).not.toHaveBeenCalled();
  });

  test("the confirmation button signs out in one click", async () => {
    arriveWith({ loadedAt: "/logout", referrer: "https://evil.example/" });
    const container = await render();

    await act(async () => {
      signOutButton(container)!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/api/auth/logout");
    expect(container.textContent).toContain("Signing out");
  });

  test("an in-app navigation (document loaded elsewhere) signs out immediately", async () => {
    arriveWith({ loadedAt: "/account", referrer: "https://evil.example/" });
    const container = await render();

    expect(assign).toHaveBeenCalledWith("/api/auth/logout");
    expect(signOutButton(container)).toBeUndefined();
  });

  test("a same-origin referrer signs out immediately", async () => {
    arriveWith({ loadedAt: "/logout", referrer: `${ORIGIN}/account/profile` });
    await render();
    expect(assign).toHaveBeenCalledWith("/api/auth/logout");
  });
});
