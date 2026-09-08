/// <reference types="bun" />
// The one discount slot, and who gets it.
//
// A Checkout Session holds a single discount and takes promotion codes instead
// of a server-set coupon, so the house sale and a code the buyer types compete
// for the same slot. The rule these tests pin down is that the better of the
// two wins — a buyer who types a valid-but-worse code must not end up paying
// more than one who types nothing.
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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

// Every buyer-typed outcome is a PostHog event, so they're asserted here rather
// than left to be discovered missing in a dashboard. Stubbed before the
// component is imported so it binds to this trackEvent.
let events: Array<{ event: string; props?: Record<string, unknown> }> = [];
mock.module("../lib/analytics", () => ({
  trackEvent: (event: string, props?: Record<string, unknown>) => {
    events.push({ event, props });
  },
}));

const { PromoCode } = await import("./PromoCode");
import type { PromoInfo } from "../lib/promo";

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

beforeEach(() => {
  events = [];
});

afterEach(async () => {
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

// React ignores a dispatched "input" event under happy-dom, so write through the
// prototype setter (assigning .value goes through React's own value tracker)
// and dispatch keyup.
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    input.focus();
    setter?.call(input, value);
    input.dispatchEvent(new Event("keyup", { bubbles: true }));
  });
}

// --- a Checkout Session that behaves like Stripe's --------------------------
// Codes this fake knows, and what each is worth in minor units. Anything else
// is rejected the way Stripe rejects an unknown code.
const WORTH: Record<string, number> = { SALE20: 2000, SAVE10: 1000, BIG50: 5000 };

type CheckoutProp = ComponentProps<typeof PromoCode>["checkout"];

function fakeCheckout() {
  const calls: string[] = [];
  let applied: string | null = null;

  const session = () => {
    const value = applied ? WORTH[applied] : 0;
    return {
      total: { discount: { minorUnitsAmount: value, amount: `$${value / 100}` } },
      discountAmounts: applied
        ? [
            {
              promotionCode: applied,
              minorUnitsAmount: value,
              amount: `$${value / 100}`,
              displayName: applied,
            },
          ]
        : null,
    };
  };

  const checkout = {
    currency: "usd",
    get total() {
      return session().total;
    },
    get discountAmounts() {
      return session().discountAmounts;
    },
    applyPromotionCode: async (code: string) => {
      calls.push(`apply:${code}`);
      const upper = code.toUpperCase();
      if (!(upper in WORTH)) {
        return {
          type: "error" as const,
          error: { message: "That promotion code is invalid.", code: "invalidCode" },
        };
      }
      applied = upper;
      return { type: "success" as const, session: session() };
    },
    removePromotionCode: async () => {
      calls.push("remove");
      applied = null;
      return { type: "success" as const, session: session() };
    },
  };

  return {
    calls,
    checkout: checkout as unknown as CheckoutProp,
    applied: () => applied,
  };
}

const sale: PromoInfo = {
  code: "SALE20",
  name: "Spring sale",
  kind: "percent",
  percentOff: 20,
};

const codeInput = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>('input[type="text"]');

const applyButton = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("Apply"));

const removeButton = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("Remove"));

async function redeem(container: HTMLElement, code: string) {
  const input = codeInput(container);
  expect(input).not.toBeNull();
  await typeInto(input as HTMLInputElement, code);
  await act(async () => {
    applyButton(container)?.click();
  });
}

describe("PromoCode", () => {
  test("applies the house sale for the buyer, once", async () => {
    const fake = fakeCheckout();
    const { container, rerender } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    expect(fake.calls).toEqual(["apply:SALE20"]);

    // Re-rendering (as a Session update would) must not re-apply it.
    await rerender(<PromoCode checkout={fake.checkout} promo={sale} surface="membership" />);
    expect(fake.calls).toEqual(["apply:SALE20"]);
    expect(container.textContent).toContain("20% off");
    expect(container.textContent).toContain("Spring sale");
    // The sale applying itself is not a buyer action, so it sends nothing —
    // it would fire on every checkout while a sale runs.
    expect(events).toEqual([]);
  });

  test("a better code takes the slot", async () => {
    const fake = fakeCheckout();
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    await redeem(container, "big50");

    expect(fake.applied()).toBe("BIG50");
    expect(container.textContent).toContain("BIG50");
    expect(container.textContent).toContain("you save $50");
    expect(events).toEqual([
      {
        event: "promo_code_applied",
        props: {
          surface: "membership",
          code: "BIG50",
          discount_minor: 5000,
          currency: "usd",
        },
      },
    ]);
  });

  test("a worse code loses to the sale, and says so", async () => {
    const fake = fakeCheckout();
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    await redeem(container, "SAVE10");

    // SAVE10 is real and valid — it's just worth less than the sale it would
    // have displaced, and only one of them can apply.
    expect(fake.applied()).toBe("SALE20");
    expect(container.textContent).toContain(
      "The current sale is a better deal than SAVE10",
    );
    // Reported as a rejection, not an application: they typed it and didn't get
    // it. The reason separates "we kept the better deal" from a bad code.
    expect(events).toEqual([
      {
        event: "promo_code_rejected",
        props: { surface: "membership", code: "SAVE10", reason: "worse_than_sale" },
      },
    ]);
  });

  test("an invalid code reports Stripe's reason and keeps the sale", async () => {
    const fake = fakeCheckout();
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    await redeem(container, "NOPE");

    expect(container.textContent).toContain("That promotion code is invalid.");
    // The slot was emptied to try the code; a failure has to put the sale back.
    expect(fake.applied()).toBe("SALE20");
    expect(events).toEqual([
      {
        event: "promo_code_rejected",
        props: { surface: "membership", code: "NOPE", reason: "invalid" },
      },
    ]);
  });

  test("removing a typed code restores the sale, not full price", async () => {
    const fake = fakeCheckout();
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    await redeem(container, "BIG50");
    expect(removeButton(container)).toBeDefined();

    await act(async () => {
      removeButton(container)?.click();
    });
    expect(fake.applied()).toBe("SALE20");
    expect(container.textContent).toContain("the sale is back");
    expect(events.map((e) => e.event)).toEqual([
      "promo_code_applied",
      "promo_code_removed",
    ]);
  });

  test("with no sale running, a code just applies", async () => {
    const fake = fakeCheckout();
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={null} surface="gift" />,
    );
    expect(fake.calls).toEqual([]);

    await redeem(container, "SAVE10");
    expect(fake.applied()).toBe("SAVE10");
    // Nothing held the slot, so there was nothing to clear first.
    expect(fake.calls).toEqual(["apply:SAVE10"]);
  });
});
