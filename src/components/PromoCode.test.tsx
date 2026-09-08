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
// Codes this fake knows: what each takes off an invoice, and how many invoices
// it survives to — the second half matters, because a discount is worth what it
// takes off every invoice it lasts for, not what it takes off today's. Anything
// else is rejected the way Stripe rejects an unknown code.
type Lasts = { type: "forever" } | { type: "repeating"; durationInMonths: number } | null;
const CODES: Record<string, { minor: number; lasts: Lasts }> = {
  SALE20: { minor: 2000, lasts: { type: "forever" } },
  SAVE10: { minor: 1000, lasts: { type: "forever" } },
  BIG50: { minor: 5000, lasts: { type: "forever" } },
  // Both take more off the FIRST invoice than the sale does, and nothing off any
  // invoice after it. FIRSTFREE is a free month against a $5.99 monthly plan;
  // ONEOFF25 is the same shape against the yearly one.
  FIRSTFREE: { minor: 5990, lasts: null },
  ONEOFF25: { minor: 2500, lasts: null },
};

type CheckoutProp = ComponentProps<typeof PromoCode>["checkout"];

function fakeCheckout(recurring: { interval: string; intervalCount: number } | null = {
  interval: "month",
  intervalCount: 1,
}) {
  const calls: string[] = [];
  let applied: string | null = null;
  let throwOnApply: string | null = null;

  const session = () => {
    const entry = applied ? CODES[applied] : null;
    const value = entry?.minor ?? 0;
    return {
      recurring,
      total: { discount: { minorUnitsAmount: value, amount: `$${value / 100}` } },
      discountAmounts:
        applied && entry
          ? [
              {
                promotionCode: applied,
                minorUnitsAmount: entry.minor,
                amount: `$${entry.minor / 100}`,
                displayName: applied,
                recurring: entry.lasts,
              },
            ]
          : null,
    };
  };

  const checkout = {
    currency: "usd",
    get recurring() {
      return recurring;
    },
    get total() {
      return session().total;
    },
    get discountAmounts() {
      return session().discountAmounts;
    },
    applyPromotionCode: async (code: string) => {
      calls.push(`apply:${code}`);
      const upper = code.toUpperCase();
      // The connection dying mid-call — Stripe throws rather than answering
      // {type:'error'}, which is a different path through the component.
      if (throwOnApply !== null && upper === throwOnApply) {
        throw new Error("network down");
      }
      if (!(upper in CODES)) {
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
    throwOn: (code: string) => {
      throwOnApply = code;
    },
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

  test("a code worth more today, and nothing after, still loses to the sale", async () => {
    const fake = fakeCheckout();
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    await redeem(container, "FIRSTFREE");

    // FIRSTFREE takes $59.90 off the first invoice against the sale's $20, so
    // on today's number alone it wins — and the buyer is worse off from the
    // second month on, every month, for as long as they stay. What the two are
    // worth over the same stretch of time is the only comparison that answers
    // the question the rule is actually asking.
    expect(fake.applied()).toBe("SALE20");
    expect(container.textContent).toContain(
      "The current sale is a better deal than FIRSTFREE",
    );
    expect(events).toEqual([
      {
        event: "promo_code_rejected",
        props: { surface: "membership", code: "FIRSTFREE", reason: "worse_than_sale" },
      },
    ]);
  });

  test("the yearly plan is valued over more than one invoice too", async () => {
    // The reason the horizon is two years rather than one: a one-year horizon
    // spans a single yearly invoice, and every discount on that plan collapses
    // back to what it takes off today — the comparison this replaced. Here
    // ONEOFF25 takes $25 off the only invoice it touches, against $20 off each
    // of the two the sale reaches.
    const fake = fakeCheckout({ interval: "year", intervalCount: 1 });
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    await redeem(container, "ONEOFF25");
    expect(fake.applied()).toBe("SALE20");
  });

  test("a one-off big enough to win over the horizon does win", async () => {
    // The rule is a comparison, not a thumb on the scale for the house. On the
    // yearly plan the sale is worth $20 twice; FIRSTFREE's $59.90 once beats
    // that, so it takes the slot — the same arithmetic that kept the sale on
    // the monthly plan, run on the numbers that actually apply here.
    const fake = fakeCheckout({ interval: "year", intervalCount: 1 });
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    await redeem(container, "FIRSTFREE");
    expect(fake.applied()).toBe("FIRSTFREE");
  });

  test("a call that throws puts the sale back and lets the buyer try again", async () => {
    const fake = fakeCheckout();
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );
    fake.throwOn("BIG50");
    await redeem(container, "BIG50");

    // The slot was emptied to make room for BIG50 and the apply never landed.
    // Leaving it empty would silently move the buyer from the sale to full
    // price — the one outcome worse than refusing their code.
    expect(fake.applied()).toBe("SALE20");
    expect(container.textContent).toContain("We couldn't apply that code");
    // And the field is usable again: without the finally, both it and the Apply
    // button stayed disabled with nothing on screen to explain why.
    expect(codeInput(container)?.disabled).toBe(false);
    expect(applyButton(container)?.disabled).toBe(false);
    expect(events).toEqual([
      {
        event: "promo_code_rejected",
        props: { surface: "membership", code: "BIG50", reason: "error" },
      },
    ]);
  });

  test("a sale that fails to apply says so instead of showing full price", async () => {
    const fake = fakeCheckout();
    fake.throwOn("SALE20");
    const { container } = await render(
      <PromoCode checkout={fake.checkout} promo={sale} surface="membership" />,
    );

    // The buyer was told on the email step that the sale was already applied.
    // Meeting the full price here with no word about it is the version of this
    // they have no way to notice.
    expect(fake.applied()).toBeNull();
    expect(container.textContent).toContain("Spring sale couldn't be applied");
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
