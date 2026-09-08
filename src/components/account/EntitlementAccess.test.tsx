/// <reference types="bun" />
// The account page's per-axis rows and the "switch to the Bundle" flow behind
// them (D9). Everything here is about what a member is shown at the moment they
// change what they pay, which is the moment a wrong sentence costs the most:
//
//   1. A preview that FAILS is not a member without a subscription. Treating
//      them alike routed someone with a healthy subscription into buying a
//      second one.
//   2. A failed switch keeps the panel, so the numbers the member is deciding
//      on stay on screen to retry from.
//   3. The success banner states the settlement in the member's own cadence,
//      not a hardcoded month.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// CheckoutModal (imported by EntitlementAccess) reads the Stripe key at module
// scope, so it has to be set before the module graph evaluates — see the note
// in CheckoutModal.test.tsx for why this is a dynamic import.
process.env.VITE_STRIPE_PUBLISHABLE_KEY ||= "pk_test_fake";
const { EntitlementAccess } = await import("./EntitlementAccess");

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
import { ThemeProvider } from "../../lib/theme";
import { SubscriberAuthProvider } from "../../lib/subscriberAuth";
import type { AxisAccess, BundleUpgradePreview, Me } from "../../lib/auth";

// --- fetch stub -------------------------------------------------------------
// The two endpoints this flow talks to, driven per test. Stubbing fetch rather
// than the auth module keeps the real getBundleUpgradePreview/changeTier in the
// path — the three-way preview result is half of what's under test.
type PreviewReply = { status: number; preview: BundleUpgradePreview | null };
type ChangeReply = { status: number; body: Record<string, unknown> };

let previewReply: PreviewReply;
let changeReply: ChangeReply;
let changePosts: Array<Record<string, unknown>> = [];

function stubFetch() {
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith("/api/stripe/bundle-upgrade-preview")) {
      if (previewReply.status !== 200) {
        return new Response("nope", { status: previewReply.status });
      }
      return Response.json({ preview: previewReply.preview });
    }
    if (url.startsWith("/api/stripe/change-tier")) {
      changePosts.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(changeReply.body), {
        status: changeReply.status,
        headers: { "content-type": "application/json" },
      });
    }
    return Response.json({});
  }) as typeof fetch;
}

// --- render harness ---------------------------------------------------------
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
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  g.fetch = realFetch;
});

const text = () => document.body.textContent ?? "";
const buttonWith = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );

const axis = (over: Partial<AxisAccess> = {}): AxisAccess => ({
  active: false,
  source: null,
  expiresAt: null,
  renewsAt: null,
  ...over,
});

// A member on an Ark+ SUBSCRIPTION with no community access: the shape the row
// CTA offers the bundle switch to.
function arkPlusMember(): Me {
  return {
    email: "member@example.com",
    tier: "ark-plus",
    entitlements: { arkPlus: true, circle: false },
    feeds: [],
    axes: {
      arkPlus: axis({ active: true, source: "subscription", renewsAt: "2026-10-01T00:00:00.000Z" }),
      circle: axis(),
    },
  };
}

const preview = (over: Partial<BundleUpgradePreview> = {}): BundleUpgradePreview => ({
  plan: "monthly",
  currency: "usd",
  minorFactor: 100,
  currentCents: 800,
  bundleCents: 2500,
  renewsAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

async function mount(me: Me = arkPlusMember()) {
  return render(
    <ThemeProvider>
      <SubscriberAuthProvider>
        <EntitlementAccess me={me} onRefresh={() => {}} />
      </SubscriberAuthProvider>
    </ThemeProvider>,
  );
}

// Opens the confirm panel from the Community row's "add to your plan" CTA.
async function openConfirm() {
  await mount();
  await act(async () => {
    buttonWith("Add Community")?.click();
  });
}

beforeEach(() => {
  previewReply = { status: 200, preview: preview() };
  changeReply = { status: 200, body: { ok: true, changed: true, timing: "immediate" } };
  changePosts = [];
  stubFetch();
});

describe("bundle switch — reading the preview", () => {
  test("a member with no live subscription falls back to buying the axis standalone", async () => {
    previewReply = { status: 200, preview: null };
    await openConfirm();
    // The standalone CheckoutModal, not the confirm panel.
    expect(text()).not.toContain("Add Community to your membership");
    expect(text()).toContain("Ark Community · Monthly");
  });

  test("a FAILED preview says so and offers a retry, rather than selling a second subscription", async () => {
    previewReply = { status: 500, preview: null };
    await openConfirm();
    expect(text()).toContain("We couldn't read what this change would cost");
    expect(buttonWith("Try again")).toBeDefined();
    // The trap this replaced: a member who already has a subscription being
    // dropped into checkout for another one.
    expect(text()).not.toContain("Complete your membership");
  });

  test("the retry re-reads the preview and opens the panel", async () => {
    previewReply = { status: 500, preview: null };
    await openConfirm();
    previewReply = { status: 200, preview: preview() };
    await act(async () => {
      buttonWith("Try again")?.click();
    });
    expect(text()).toContain("Add Community to your membership");
  });
});

describe("bundle switch — a failed switch", () => {
  test("keeps the panel and the numbers on screen", async () => {
    changeReply = { status: 502, body: { ok: false, error: "Could not change your plan." } };
    await openConfirm();
    await act(async () => {
      buttonWith("Switch to")?.click();
    });
    expect(text()).toContain("Could not change your plan.");
    // Both still there: the panel, and the price it quoted.
    expect(text()).toContain("Add Community to your membership");
    expect(text()).toContain("$8 → $25");
  });

})

describe("bundle switch — the success banner", () => {
  test("a monthly member is told the settlement in months", async () => {
    await openConfirm();
    await act(async () => {
      buttonWith("Switch to")?.click();
    });
    expect(text()).toContain("Nothing to pay today.");
    expect(text()).toContain("the rest of this month");
  });

  test("a yearly member is not told about a month", async () => {
    previewReply = { status: 200, preview: preview({ plan: "yearly", currentCents: 8000, bundleCents: 25_000 }) };
    await openConfirm();
    await act(async () => {
      buttonWith("Switch to")?.click();
    });
    expect(text()).toContain("the rest of this year");
    expect(text()).not.toContain("the rest of this month");
  });

  test("a member who was paying MORE than the bundle is told about credit, not a charge", async () => {
    // Pay-what-you-can above the bundle price: the switch owes them the unused
    // remainder rather than charging a difference. The confirm panel said so;
    // the banner used to contradict it.
    previewReply = { status: 200, preview: preview({ currentCents: 4000, bundleCents: 2500 }) };
    await openConfirm();
    await act(async () => {
      buttonWith("Switch to")?.click();
    });
    expect(text()).toContain("credit for what you've already paid");
    expect(text()).not.toContain("with the difference");
  });
});
