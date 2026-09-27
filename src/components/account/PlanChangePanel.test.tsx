/// <reference types="bun" />
// The billing page's confirm step for a cadence switch or a new amount. What a
// member reads here is what they're about to be charged, so the cases are the
// sentences: the price move, today's charge or the start date, and a button
// that can't submit a change that isn't one.
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
import { PlanChangePanel } from "./PlanChangePanel";
import type { ChangePreview } from "../../lib/auth";

let changePosts: Array<Record<string, unknown>> = [];
let changeReply: { status: number; body: Record<string, unknown> };

beforeEach(() => {
  changePosts = [];
  changeReply = {
    status: 200,
    body: { ok: true, changed: true, timing: "immediate", next_charge_at: "2027-09-27T00:00:00.000Z" },
  };
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith("/api/stripe/change-tier")) {
      changePosts.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(changeReply.body), { status: changeReply.status });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  g.fetch = realFetch;
});

const preview = (over: Partial<ChangePreview> = {}): ChangePreview => ({
  tier: "ark-plus",
  plan: "yearly",
  currency: "usd",
  minorFactor: 100,
  currentCents: 800,
  currentPlan: "monthly",
  floorCents: 8000,
  amountCents: 8000,
  pwyc: null,
  timing: "immediate",
  dueTodayCents: 7200,
  renewsAt: "2027-09-27T00:00:00.000Z",
  startsAt: null,
  blocked: null,
  ...over,
});

let done: string | null = null;

async function mount(p: ChangePreview) {
  done = null;
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <PlanChangePanel
        heading="Switch to annual billing"
        initial={p}
        onDone={(m) => {
          done = m;
        }}
        onCancel={() => {}}
      />,
    );
  });
}

const text = () => document.body.textContent ?? "";
const buttonWith = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );

describe("PlanChangePanel", () => {
  test("monthly → annual states the move and today's charge, then bills the catalog price", async () => {
    await mount(preview());
    expect(text()).toContain("$8 a month → $80 a year.");
    expect(text()).toContain("You pay $72 today");
    expect(text()).not.toContain("Choose your amount");
    await act(async () => buttonWith("Change to $80 a year")?.click());
    expect(changePosts[0]).toMatchObject({ tier: "ark-plus", plan: "yearly" });
    expect(changePosts[0]!.custom_amount_cents).toBeUndefined();
    expect(done).toContain("You're now paying $80 a year.");
  });

  test("annual → monthly starts at period end with nothing to pay today", async () => {
    changeReply = {
      status: 200,
      body: { ok: true, changed: true, timing: "period_end", effective_at: "2027-03-01T00:00:00.000Z" },
    };
    await mount(
      preview({
        plan: "monthly",
        currentPlan: "yearly",
        currentCents: 8000,
        floorCents: 800,
        amountCents: 800,
        timing: "period_end",
        dueTodayCents: null,
        renewsAt: null,
        startsAt: "2027-03-01T00:00:00.000Z",
      }),
    );
    expect(text()).toContain("Nothing to pay today. The new price starts on");
    await act(async () => buttonWith("Change to $8 a month")?.click());
    expect(done).toContain("from");
  });

  test("a member who chooses their own amount sees the picker, and an above-minimum amount is sent", async () => {
    await mount(
      preview({
        currentCents: 1200,
        amountCents: 12000,
        pwyc: { suggestedCents: 12000, maxCents: 8_000_000 },
        dueTodayCents: 10800,
      }),
    );
    expect(text()).toContain("Choose your amount");
    expect(text()).toContain("$12 a month → $120 a year.");
    await act(async () => buttonWith("Change to $120 a year")?.click());
    expect(changePosts[0]!.custom_amount_cents).toBe(12000);
  });

  test("the amount panel opens on today's amount and won't submit it unchanged", async () => {
    await mount(
      preview({
        plan: "monthly",
        currentCents: 1200,
        floorCents: 800,
        amountCents: 1200,
        pwyc: { suggestedCents: 1200, maxCents: 1_000_000 },
      }),
    );
    expect(text()).toContain("Move the amount to change what you pay.");
    expect(buttonWith("Change to")?.disabled).toBe(true);
  });

  test("a gift extending the plan is said, and there is no button to press", async () => {
    await mount(preview({ blocked: "gift_extension", dueTodayCents: null }));
    expect(text()).toContain("gifted membership time is still running");
    expect(buttonWith("Change to")).toBeUndefined();
  });

  test("a refused change keeps the panel and says why", async () => {
    changeReply = { status: 402, body: { ok: false, error: "Your card was declined." } };
    await mount(preview());
    await act(async () => buttonWith("Change to $80 a year")?.click());
    expect(text()).toContain("Your card was declined.");
    expect(done).toBeNull();
  });
});
