/// <reference types="bun" />
// The checkout consent boxes. Needs a real DOM because the whole point of the
// component is what a buyer can and can't click, so happy-dom is registered
// here. Bun's own `fetch` is preserved (happy-dom would otherwise replace it)
// so this registration can't disturb the server tests.
//
// Checkboxes are reachable from here in a way text inputs aren't: React routes
// checkbox changes through the `click` event, which happy-dom dispatches
// faithfully.
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

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  TERMS_STATEMENT,
  renewalStatement,
} from "../../shared/checkout-consent";
import { CheckoutConsent } from "./CheckoutConsent";
import { useCheckoutConsent, type Renewal } from "../lib/checkoutConsent";

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mounted = { root, container };
  return {
    container,
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

afterEach(async () => {
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

// Every paid submit that got past consent.confirm(). The list, not a boolean,
// so a test can also catch a second charge slipping through.
let paid: string[] = [];

function Harness({ renewal }: { renewal: Renewal | null }) {
  const consent = useCheckoutConsent(renewal);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!consent.confirm()) return;
        paid.push("charged");
      }}
    >
      <CheckoutConsent renewal={renewal} consent={consent} />
      <button type="submit">Pay</button>
    </form>
  );
}

afterEach(() => {
  paid = [];
});

const monthly: Renewal = { amount: "$8.00", period: "per month" };

const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const labels = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLLabelElement>("label")).map(
    (l) => l.textContent ?? "",
  );
const alert = (c: HTMLElement) =>
  c.querySelector('[role="alert"]')?.textContent ?? null;

const click = (el: HTMLElement | undefined) => act(async () => el?.click());
const pay = (c: HTMLElement) =>
  click(c.querySelector<HTMLButtonElement>('button[type="submit"]') ?? undefined);

describe("CheckoutConsent copy", () => {
  // The labels render the policy names as links, so the sentence is built from
  // JSX while the record sent to Stripe is built from a string. This is the
  // test that keeps them the same sentence.
  test("the terms label reads exactly as the statement we record", async () => {
    const { container } = await render(<Harness renewal={monthly} />);
    expect(labels(container)[0]).toBe(TERMS_STATEMENT);
  });

  test("the renewal label names the amount and the period", async () => {
    const { container } = await render(<Harness renewal={monthly} />);
    expect(labels(container)[1]).toBe(
      renewalStatement("$8.00", "per month"),
    );
    expect(labels(container)[1]).toContain("$8.00 per month");
  });

  test("the policies open in a new tab, not over the checkout", async () => {
    const { container } = await render(<Harness renewal={monthly} />);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/terms",
      "/privacy",
    ]);
    // A router navigation would unmount the modal and throw away both the
    // Checkout Session and the ticks already made.
    expect(links.every((a) => a.getAttribute("target") === "_blank")).toBe(true);
  });

  test("with no renewal figure, the sentence is asked without one", async () => {
    // Stripe handed back a subscription Session with no `recurring`, so the
    // next charge cannot be read. The box still has to be there — this is a
    // subscription — but naming today's total instead would put a number in
    // front of the buyer that we know is not what recurs, and stamp that same
    // number on the Session as the record of what they agreed to.
    const { container } = await render(
      <Harness renewal={{ amount: null, period: "per month" }} />,
    );
    expect(boxes(container)).toHaveLength(2);
    expect(labels(container)[1]).toBe(
      "I understand my subscription renews automatically every month until I cancel.",
    );
    expect(labels(container)[1]).toBe(renewalStatement(null, "per month"));
  });

  test("a one-time purchase gets the terms box and no renewal box", async () => {
    const { container } = await render(<Harness renewal={null} />);
    expect(boxes(container)).toHaveLength(1);
    expect(labels(container)).toEqual([TERMS_STATEMENT]);
  });
});

describe("CheckoutConsent gate", () => {
  test("nothing is charged until both boxes are ticked", async () => {
    const { container } = await render(<Harness renewal={monthly} />);

    await pay(container);
    expect(paid).toEqual([]);
    expect(alert(container)).toBe("Please tick the boxes above to continue.");

    await click(boxes(container)[0]);
    await pay(container);
    expect(paid).toEqual([]);

    await click(boxes(container)[1]);
    await pay(container);
    expect(paid).toEqual(["charged"]);
    expect(alert(container)).toBeNull();
  });

  test("a gift is charged on the one box", async () => {
    const { container } = await render(<Harness renewal={null} />);

    await pay(container);
    expect(paid).toEqual([]);
    expect(alert(container)).toBe("Please tick the box above to continue.");

    await click(boxes(container)[0]);
    await pay(container);
    expect(paid).toEqual(["charged"]);
  });

  test("unticking a box takes the consent back", async () => {
    const { container } = await render(<Harness renewal={monthly} />);
    await click(boxes(container)[0]);
    await click(boxes(container)[1]);
    await click(boxes(container)[1]);

    await pay(container);
    expect(paid).toEqual([]);
  });
});

describe("CheckoutConsent when the renewal amount moves", () => {
  // Tax lands on the disclosed total the moment a usable billing address is
  // entered, which can happen after the box was ticked. A tick against the old
  // number is consent to a sentence we're no longer showing.
  test("a changed amount withdraws the tick and says so", async () => {
    const { container, rerender } = await render(<Harness renewal={monthly} />);
    await click(boxes(container)[0]);
    await click(boxes(container)[1]);
    expect(boxes(container)[1]?.checked).toBe(true);

    await rerender(
      <Harness renewal={{ amount: "$8.64", period: "per month" }} />,
    );
    expect(boxes(container)[1]?.checked).toBe(false);
    expect(labels(container)[1]).toContain("$8.64");
    expect(alert(container)).toBe(
      "The renewal amount changed — please confirm it again.",
    );

    await pay(container);
    expect(paid).toEqual([]);

    // Re-ticking against the new number is enough; the terms box is untouched.
    await click(boxes(container)[1]);
    await pay(container);
    expect(paid).toEqual(["charged"]);
  });

  test("an unchanged amount leaves a ticked box alone", async () => {
    const { container, rerender } = await render(<Harness renewal={monthly} />);
    await click(boxes(container)[0]);
    await click(boxes(container)[1]);

    // Any unrelated parent update — a wallet becoming available, a promo
    // banner arriving — must not silently reset the acceptance.
    await rerender(<Harness renewal={{ ...monthly }} />);
    expect(boxes(container)[1]?.checked).toBe(true);
    expect(alert(container)).toBeNull();
  });
});
