/// <reference types="bun" />
// The private-feed setup page. Needs a real DOM because what's being asserted
// is where a click goes and what appears after it, so happy-dom is registered
// here. Bun's own `fetch` is preserved (happy-dom would otherwise replace it)
// so this registration can't disturb the server tests.
//
// Two behaviours, both of which broke in front of a member:
//
// 1. The Spotify hand-off leaves for Beehiiv and never comes back (Beehiiv's
//    `redirect_path` can't leave its domain — see SPOTIFY_HANDOFF_PATH), so the
//    link must open in a NEW tab and the "now follow the show" step must appear
//    on this page once they've been sent off.
// 2. A member holds a feed per premium show, and four of them turned this page
//    into an unreadable stack. Each show is a disclosure row: the checklist
//    stays visible, one show is open, and finishing one moves to the next.
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

function feed(id: string, name: string, extra: Partial<UserFeed> = {}): UserFeed {
  return { ...FEED, id, name, ...extra };
}

/** The disclosure button for one show, by its title. */
function showToggle(container: HTMLElement, name: string): HTMLButtonElement {
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ];
  const found = buttons.find((b) => b.textContent?.includes(name));
  if (!found) throw new Error(`no disclosure row for "${name}"`);
  return found;
}

const isOpen = (container: HTMLElement, name: string) =>
  showToggle(container, name).getAttribute("aria-expanded") === "true";

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

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

// A member reaches this page before Beehiiv has minted their feeds — it mints
// them seconds after the membership lands — so the empty state is the first
// thing many new members see. It has to say which of the two situations they're
// in: still coming, or genuinely not there.
describe("FeedSetup — no feeds yet", () => {
  test("says they're on the way while the page is still polling", async () => {
    const container = await render(<FeedSetup feeds={[]} provisioning />);

    expect(container.textContent).toContain("Setting up your private feeds");
    expect(container.textContent).not.toContain("No private feeds");
  });

  test("stops promising them once the poll has given up", async () => {
    const container = await render(<FeedSetup feeds={[]} />);

    expect(container.textContent).toContain(
      "No private feeds on your membership yet",
    );
    // The membership is fine and the page says so — the feed is the only thing
    // missing, and there's a way to ask about it from here.
    expect(container.textContent).toContain("Your membership is active");
    expect(container.textContent).toContain("hit Help");
  });
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

// Four premium shows made the flat list unreadable, so each show is a
// disclosure row. What has to hold: the checklist stays visible, exactly one
// show is expanded, and finishing one moves to the next thing to do.
describe("FeedSetup — one show at a time", () => {
  const FEEDS = [
    feed("pod_a", "Alpha Show", { activated: true }),
    feed("pod_b", "Bravo Show"),
    feed("pod_c", "Charlie Show"),
  ];

  test("every show is listed, whether or not it's open", async () => {
    const container = await render(<FeedSetup feeds={FEEDS} />);

    for (const f of FEEDS) expect(container.textContent).toContain(f.name);
    // The one already in an app says so without being opened.
    expect(showToggle(container, "Alpha Show").textContent).toContain("Set up");
  });

  test("opens the first show that still needs doing, not the first show", async () => {
    const container = await render(<FeedSetup feeds={FEEDS} />);

    expect(isOpen(container, "Alpha Show")).toBe(false);
    expect(isOpen(container, "Bravo Show")).toBe(true);
    expect(isOpen(container, "Charlie Show")).toBe(false);
  });

  test("opening one closes the other", async () => {
    const container = await render(<FeedSetup feeds={FEEDS} />);

    await click(showToggle(container, "Charlie Show"));

    expect(isOpen(container, "Charlie Show")).toBe(true);
    expect(isOpen(container, "Bravo Show")).toBe(false);
  });

  test("a second click collapses it, leaving nothing open", async () => {
    const container = await render(<FeedSetup feeds={FEEDS} />);

    await click(showToggle(container, "Bravo Show"));

    expect(isOpen(container, "Bravo Show")).toBe(false);
  });

  test("finishing a show moves on to the next one still to do", async () => {
    const container = await render(<FeedSetup feeds={FEEDS} />);

    // The desktop "open here" escape hatch inside the open show — one of the
    // actions that counts a feed as set up.
    const openHere = [
      ...container.querySelectorAll<HTMLAnchorElement>('a[href="podcast://feed"]'),
    ].at(-1);
    if (!openHere) throw new Error("no app link in the open show");
    await click(openHere);

    expect(markedFeeds).toEqual([["pod_b"]]);
    expect(isOpen(container, "Bravo Show")).toBe(false);
    expect(isOpen(container, "Charlie Show")).toBe(true);
  });
});
