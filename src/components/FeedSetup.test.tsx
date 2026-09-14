/// <reference types="bun" />
// The Spotify half of the private-feed setup page. Needs a real DOM because
// what's being asserted is where a click goes and what appears after it, so
// happy-dom is registered here. Bun's own `fetch` is preserved (happy-dom would
// otherwise replace it) so this registration can't disturb the server tests.
//
// Why this exists: the hand-off leaves for Beehiiv and never comes back
// (Beehiiv's `redirect_path` can't leave its own domain — see
// SPOTIFY_HANDOFF_PATH in FeedSetup), so two things have to hold or the flow
// strands the member on beehiiv.com. The link must open in a NEW tab, and the
// "now follow the show" step must appear on this page once they've been sent
// off.
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
import type { UserFeed } from "../lib/auth";

// Only the one write is stubbed — everything else is the real module, because
// `mock.module` is process-wide and other suites import from here. The real
// provider then runs for real: without a session cookie it resolves to guest
// and makes no request of its own.
const realAuth = await import("../lib/auth");
let markedFeeds: string[][] = [];
mock.module("../lib/auth", () => ({
  ...realAuth,
  persistFeedsSetUp: async (feedIds: string[]) => {
    markedFeeds.push(feedIds);
  },
}));

const { FeedSetup } = await import("./FeedSetup");
const { SubscriberAuthProvider } = await import("../lib/subscriberAuth");

const FEED: UserFeed = {
  id: "pod_show",
  name: "Inside Call me Back",
  url: "https://podcasts.beehiiv.com/feed/abc123",
  protocolLinks: { apple: "podcast://feed" },
};

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SubscriberAuthProvider>{ui}</SubscriberAuthProvider>);
  });
  mounted = { root, container };
  return container;
}

/** The "Link Spotify" CTA — the only link pointing at the hand-off route. */
function spotifyCta(container: HTMLElement): HTMLAnchorElement {
  const link = container.querySelector<HTMLAnchorElement>(
    'a[href="/api/me/feeds/spotify"]',
  );
  if (!link) throw new Error("no Spotify hand-off link rendered");
  return link;
}

/** Any link that sends the member to Spotify itself, rather than to Beehiiv. */
function followLink(container: HTMLElement): HTMLAnchorElement | null {
  return container.querySelector<HTMLAnchorElement>(
    'a[href^="https://open.spotify.com"]',
  );
}

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  markedFeeds = [];
});

describe("FeedSetup — Spotify", () => {
  test("hands off in a new tab, so the member keeps this page", async () => {
    const container = await render(<FeedSetup feeds={[FEED]} />);

    expect(spotifyCta(container).target).toBe("_blank");
  });

  test("offers the follow step only once the member has been handed off", async () => {
    const container = await render(<FeedSetup feeds={[FEED]} />);
    expect(followLink(container)).toBeNull();

    await act(async () => {
      spotifyCta(container).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(followLink(container)).not.toBeNull();
    // The click also checks every show off — one link covers the network.
    expect(markedFeeds).toEqual([[FEED.id]]);
  });

  test("shows the follow step straight away when Beehiiv returns the marker", async () => {
    const container = await render(<FeedSetup feeds={[FEED]} spotifyLinked />);

    expect(followLink(container)).not.toBeNull();
    expect(container.textContent).toContain("Spotify is linked");
  });
});
