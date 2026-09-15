/// <reference types="bun" />
// The membership snapshot every gated surface reads.
//
// What's pinned here is that the snapshot gets QUESTIONED, not just taken.
// /api/me is fetched once on mount and ~25 components read that one result, so
// anything that changes server-side afterwards is invisible until something
// asks again — which is how a member who had four private feeds spent a minute
// being told they had none (Beehiiv mints them ~35s after the membership
// lands). Coming back to the tab is that something.
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

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Me } from "./auth";

const ME: Me = {
  email: "member@x.com",
  tier: "ark-plus",
  entitlements: { arkPlus: true, circle: false },
  feeds: [],
};

// Only the read is stubbed — `mock.module` is process-wide and other suites
// import from this module, so everything else stays real.
const realAuth = await import("./auth");
let meCalls = 0;
mock.module("./auth", () => ({
  ...realAuth,
  fetchMe: async () => {
    meCalls += 1;
    return ME;
  },
}));

const { SubscriberAuthProvider } = await import("./subscriberAuth");

const SESSION_COOKIE = "ark_session_present";

// No `path=/` on purpose: the test document is `about:blank`, and happy-dom
// drops a cookie whose path doesn't match the (pathless) document URL — it
// stores nothing and reports no error, which reads exactly like a broken
// session check.
function setSession(present: boolean) {
  document.cookie = present
    ? `${SESSION_COOKIE}=1`
    : `${SESSION_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

let mounted: { root: Root; container: HTMLElement } | null = null;

async function mountProvider() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SubscriberAuthProvider>
        <div />
      </SubscriberAuthProvider>,
    );
  });
  mounted = { root, container };
}

/** Back to the tab, `ms` after the last read. */
async function refocus(ms: number) {
  setSystemTime(new Date(Date.now() + ms));
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  meCalls = 0;
  setSession(true);
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  // Both are process-wide: a session cookie or a frozen clock left behind
  // would follow whichever suite runs next.
  setSession(false);
  setSystemTime();
});

describe("SubscriberAuthProvider — revalidation", () => {
  test("re-reads the membership when the member comes back to the tab", async () => {
    await mountProvider();
    expect(meCalls).toBe(1);

    await refocus(60_000);

    expect(meCalls).toBe(2);
  });

  test("doesn't re-ask on every alt-tab", async () => {
    await mountProvider();
    expect(meCalls).toBe(1);

    await refocus(1_000);

    expect(meCalls).toBe(1);
  });

  test("a guest costs nothing — the public site mounts this too", async () => {
    setSession(false);
    await mountProvider();
    expect(meCalls).toBe(0);

    await refocus(60_000);

    expect(meCalls).toBe(0);
  });
});
