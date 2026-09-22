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
let meImpl: () => Promise<Me> = async () => ME;
let persistFollowImpl: () => Promise<boolean> = async () => true;
mock.module("./auth", () => ({
  ...realAuth,
  fetchMe: async () => {
    meCalls += 1;
    return meImpl();
  },
  persistSpotifyFollowOpened: () => persistFollowImpl(),
  persistFeedsSetUp: async () => {},
}));

const { SubscriberAuthProvider, useSubscriberAuth } = await import(
  "./subscriberAuth"
);

type AuthValue = ReturnType<typeof useSubscriberAuth>;
let ctx: AuthValue | null = null;
function Probe({ onValue }: { onValue: (v: AuthValue) => void }) {
  onValue(useSubscriberAuth());
  return null;
}

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
        <Probe onValue={(v) => (ctx = v)} />
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
  meImpl = async () => ME;
  persistFollowImpl = async () => true;
  ctx = null;
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

describe("SubscriberAuthProvider — Spotify follow ticks", () => {
  const SHOW: Me["feeds"][number] = { id: "pod_a", name: "Alpha", url: "https://x" };
  const WITH_FEED: Me = { ...ME, feeds: [SHOW] };

  function opened(): boolean | undefined {
    const state = ctx?.state;
    return state?.kind === "member"
      ? state.me.feeds[0]?.spotify_follow_opened
      : undefined;
  }

  // The member clicks, the phone hands off to Spotify, and the refresh on
  // return was sent before the tick's save committed — so it answers without
  // the tick. It must not untick the row.
  test("a read that predates the save doesn't undo the tick", async () => {
    meImpl = async () => WITH_FEED;
    await mountProvider();

    let answerStaleRead: (me: Me) => void = () => {};
    meImpl = () => new Promise<Me>((resolve) => (answerStaleRead = resolve));
    await refocus(60_000);

    await act(async () => ctx!.markSpotifyFollowOpened("pod_a"));
    expect(opened()).toBe(true);

    await act(async () => answerStaleRead(WITH_FEED));
    expect(opened()).toBe(true);
  });

  test("a failed save takes the tick back, and later reads don't restore it", async () => {
    meImpl = async () => WITH_FEED;
    persistFollowImpl = async () => false;
    await mountProvider();

    await act(async () => ctx!.markSpotifyFollowOpened("pod_a"));
    expect(opened()).toBe(false);

    await refocus(60_000);
    expect(opened()).toBeUndefined();
  });
});

describe("SubscriberAuthProvider — set-up marks", () => {
  const SHOW: Me["feeds"][number] = { id: "pod_a", name: "Alpha", url: "https://x" };
  const WITH_FEED: Me = { ...ME, feeds: [SHOW] };

  function feedA() {
    const state = ctx?.state;
    return state?.kind === "member" ? state.me.feeds[0] : undefined;
  }

  // Back from Spotify's consent screen, the page marks every show set up while
  // the refresh on return is still in flight without the marker.
  test("a read that predates the save doesn't undo the check-off", async () => {
    meImpl = async () => WITH_FEED;
    await mountProvider();

    let answerStaleRead: (me: Me) => void = () => {};
    meImpl = () => new Promise<Me>((resolve) => (answerStaleRead = resolve));
    await refocus(60_000);

    await act(async () => ctx!.markFeedsSetUp(["pod_a"]));
    expect(feedA()?.pending).toBe(true);

    await act(async () => answerStaleRead(WITH_FEED));
    expect(feedA()?.pending).toBe(true);
  });

  test("never paints pending over a feed the server reports activated", async () => {
    meImpl = async () => WITH_FEED;
    await mountProvider();
    await act(async () => ctx!.markFeedsSetUp(["pod_a"]));

    meImpl = async () => ({ ...ME, feeds: [{ ...SHOW, activated: true, pending: false }] });
    await refocus(60_000);

    expect(feedA()).toMatchObject({ activated: true, pending: false });
  });
});
