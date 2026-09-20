/// <reference types="bun" />
// The post-cancel survey, driven through the real flow.
//
// The survey is tier-aware: an Ark+ member is asked about listening, a Fold
// member about the community, and a member who cancels the whole bundle gets
// the shared reasons once plus a sub-question per product. Rendering one flat
// list for everyone — or asking a Fold member why they stopped listening — is
// the regression these cover, along with the slug that actually reaches the
// server when a product-specific box is checked.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
import { CancelFlow } from "./CancelFlow";

// --- fetch stub -------------------------------------------------------------
// Only the endpoints are stubbed; the real lib/auth calls stay in the path, so
// `surveyPosts` holds exactly the body the server would receive.
let surveyPosts: Array<Record<string, unknown>> = [];

function stubFetch() {
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    // No save offers: the offer screen still shows as the "Are you sure?" step,
    // and declining it commits the cancel.
    if (url.startsWith("/api/stripe/save-offers"))
      return Response.json({ offers: [], standalone: null });
    if (url.startsWith("/api/stripe/bundle-breakdown"))
      return Response.json({ breakdown: null });
    if (url.startsWith("/api/stripe/cancel-subscription"))
      return Response.json({
        ok: true,
        access_until: "2026-10-01T00:00:00.000Z",
        survey_id: 7,
      });
    if (url.startsWith("/api/stripe/cancellation-survey")) {
      surveyPosts.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ ok: true });
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
}

beforeEach(() => {
  surveyPosts = [];
  stubFetch();
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  g.fetch = realFetch;
});

/** Click the button whose visible text is exactly `label`. */
async function click(label: string) {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  await act(async () => {
    found.click();
  });
}

/** Tick the checkbox whose label text is exactly `label`. */
async function check(label: string) {
  const found = [...document.body.querySelectorAll<HTMLLabelElement>("label")].find(
    (l) => (l.textContent ?? "").trim() === label,
  );
  const box = found?.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (!box) throw new Error(`no checkbox labelled "${label}"`);
  await act(async () => {
    box.click();
  });
}

const heading = () => document.querySelector("#cancel-title")?.textContent?.trim();
/** The reason labels on screen, in display order. */
const reasons = () =>
  [...document.body.querySelectorAll("fieldset label")].map((l) =>
    (l.textContent ?? "").trim(),
  );
/** The visible sub-questions (the opening group's legend is screen-reader only). */
const subQuestions = () =>
  [...document.body.querySelectorAll("fieldset legend")]
    .filter((l) => !l.className.includes("sr-only"))
    .map((l) => (l.textContent ?? "").trim());

const noop = () => {};

/** Mount a flow and walk it to the post-cancel survey. */
async function toSurvey(tier: "ark-plus" | "circle" | "bundle") {
  await render(
    <CancelFlow
      tier={tier}
      plan="monthly"
      onClose={noop}
      onSaved={noop}
      onCancelled={noop}
      onDebundled={noop}
    />,
  );
  if (tier === "bundle") {
    await click("Continue");
    // The selector opens with both products kept; unchecking both is the full
    // cancel (Flow E), which lands straight on the survey.
    await check("Ark+");
    await check("The Fold");
    await click("Cancel all services");
  } else {
    await click("Continue to cancel");
    await click("No thanks, just cancel");
  }
}

describe("a member cancelling Ark+", () => {
  test("is asked about Ark+, not the community", async () => {
    await toSurvey("ark-plus");
    expect(heading()).toBe("Your Ark+ subscription has been cancelled");
    expect(reasons()).toEqual([
      "I subscribed for specific episodes or a series and finished them.",
      "I'm not listening regularly.",
      "It's too expensive for me right now.",
      "I'm cutting back on subscriptions.",
      "The content or topics weren't what I expected.",
      "I subscribed mainly to support Ark Media and don't need an ongoing subscription",
      "I had trouble accessing the content or using my podcast app.",
      "Other (please tell us more).",
    ]);
    expect(subQuestions()).toEqual([]);
  });
});

describe("a member cancelling the Fold", () => {
  test("is asked about the community, not listening", async () => {
    await toSurvey("circle");
    expect(heading()).toBe("Your subscription to The Fold has been cancelled");
    expect(reasons()).toEqual([
      "I wasn't spending enough time in The Fold.",
      "It's too expensive for me right now.",
      "I'm cutting back on subscriptions.",
      "It was hard to find people or conversations I connected with.",
      "There was too much going on to keep up with.",
      "I had trouble with the app, login, or accessing the community.",
      "The conversations or community culture weren't the right fit for me.",
      "Other (please tell us more).",
    ]);
    expect(subQuestions()).toEqual([]);
  });

  test("submits the Fold's own slug for its own reason", async () => {
    await toSurvey("circle");
    await check("I had trouble with the app, login, or accessing the community.");
    await click("Submit");
    expect(surveyPosts).toHaveLength(1);
    expect(surveyPosts[0]).toMatchObject({
      survey_id: 7,
      // Not `technical_issues` — that one means a podcast app.
      reasons: ["fold_technical_issues"],
    });
  });
});

describe("a member cancelling the whole bundle", () => {
  test("is asked the shared reasons once, then one question per product", async () => {
    await toSurvey("bundle");
    expect(heading()).toBe("Your subscription has been cancelled");
    expect(subQuestions()).toEqual([
      "What made you decide to cancel Ark+?",
      "What made you decide to cancel The Fold?",
    ]);
    expect(reasons()).toEqual([
      "It's too expensive for me right now.",
      "I'm cutting back on subscriptions.",
      "Other (please tell us more).",
      "I subscribed for specific episodes or a series and finished them.",
      "I'm not listening regularly.",
      "The content or topics weren't what I expected.",
      "I subscribed mainly to support Ark Media and don't need an ongoing subscription",
      "I had trouble accessing the content or using my podcast app.",
      "I wasn't spending enough time in The Fold.",
      "It was hard to find people or conversations I connected with.",
      "There was too much going on to keep up with.",
      "I had trouble with the app, login, or accessing the community.",
      "The conversations or community culture weren't the right fit for me.",
    ]);
  });

  test("can name a reason from every group in one submit", async () => {
    await toSurvey("bundle");
    await check("I'm cutting back on subscriptions.");
    await check("I'm not listening regularly.");
    await check("There was too much going on to keep up with.");
    await click("Submit");
    expect(surveyPosts).toHaveLength(1);
    expect((surveyPosts[0] as { reasons: string[] }).reasons.sort()).toEqual([
      "cutting_back",
      "fold_overwhelming",
      "not_listening",
    ]);
  });

  test('"Other" still opens the free-text note', async () => {
    await toSurvey("bundle");
    expect(document.querySelector("#cancel-note")).toBeNull();
    await check("Other (please tell us more).");
    expect(document.querySelector("#cancel-note")).not.toBeNull();
  });
});
