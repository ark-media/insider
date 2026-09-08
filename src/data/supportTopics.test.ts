/// <reference types="bun" />
// The routing half of the help widget. Search quality is covered in
// src/lib/support/search.test.ts; what is asserted here is the promise the
// topic table makes about WHERE it sends people, which is the half that can
// send a paying member somewhere useless without anything looking broken.
import { describe, expect, test } from "bun:test";
import {
  actionsFor,
  supportTopicById,
  supportTopics,
  visibleTopics,
  type SupportAction,
  type SupportViewer,
} from "./supportTopics";

const guest: SupportViewer = { signedIn: false, arkPlus: false, circle: false, free: false };
const free: SupportViewer = { signedIn: true, arkPlus: false, circle: false, free: true };
const arkPlus: SupportViewer = { signedIn: true, arkPlus: true, circle: false, free: false };
const circle: SupportViewer = { signedIn: true, arkPlus: false, circle: true, free: false };
const bundle: SupportViewer = { signedIn: true, arkPlus: true, circle: true, free: false };

const VIEWERS: [string, SupportViewer][] = [
  ["guest", guest],
  ["free", free],
  ["ark+", arkPlus],
  ["circle", circle],
  ["bundle", bundle],
];

const routesOf = (actions: SupportAction[]) =>
  actions.flatMap((a) => (a.kind === "route" ? [a.to] : []));

describe("topic table integrity", () => {
  test("ids are unique", () => {
    const ids = supportTopics.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every topic offers at least one action for every viewer", () => {
    for (const topic of supportTopics) {
      for (const [name, viewer] of VIEWERS) {
        if (topic.visibleWhen && !topic.visibleWhen(viewer)) continue;
        expect(
          actionsFor(topic, viewer).length,
          `${topic.id} has no action for a ${name}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("labels and blurbs follow the house voice", () => {
    for (const topic of supportTopics) {
      // Chips are labels, not sentences.
      expect(topic.label.endsWith(".")).toBe(false);
      expect(topic.label).not.toContain("!");
      expect(topic.blurb.length).toBeGreaterThan(0);
    }
  });

  test("escalate-only topics never pin an FAQ", () => {
    for (const topic of supportTopics.filter((t) => t.escalateOnly)) {
      expect(topic.faqKeys, `${topic.id}`).toEqual([]);
      expect(actionsFor(topic, guest).some((a) => a.kind === "contact")).toBe(true);
    }
  });
});

describe("guest routing — the Apple problem", () => {
  // Apple Podcasts shares no customer data, so a paying Apple subscriber has no
  // account here and reads as a guest. Every /account/* route bounces a guest
  // to /plus (src/routes/account/billing.tsx), so a widget that offers one to a
  // guest lands a paying customer on a sales page. This is the single
  // invariant the user asked the widget to absorb, so it is asserted rather
  // than left to review.
  test("no topic offers a guest an /account/* link", () => {
    for (const topic of supportTopics) {
      if (topic.visibleWhen && !topic.visibleWhen(guest)) continue;
      for (const to of routesOf(actionsFor(topic, guest))) {
        expect(to.startsWith("/account"), `${topic.id} → ${to}`).toBe(false);
      }
    }
  });

  test("no topic offers a guest /setup, which bounces non-Ark+ viewers", () => {
    for (const topic of supportTopics) {
      if (topic.visibleWhen && !topic.visibleWhen(guest)) continue;
      expect(routesOf(actionsFor(topic, guest)), topic.id).not.toContain("/setup");
    }
  });

  test("the billing and cancel topics explain Apple before offering sign-in", () => {
    for (const id of ["billing", "cancel"] as const) {
      const actions = actionsFor(supportTopicById.get(id)!, guest);
      const note = actions.findIndex((a) => a.kind === "note");
      expect(note, `${id} has no Apple fork for a guest`).toBeGreaterThanOrEqual(0);
      expect(
        (actions[note] as { kind: "note"; body: string }).body.toLowerCase(),
      ).toContain("apple");
    }
  });
});

describe("entitlement gating", () => {
  test("/setup is only ever offered to an Ark+ holder", () => {
    for (const topic of supportTopics) {
      for (const [name, viewer] of VIEWERS) {
        if (topic.visibleWhen && !topic.visibleWhen(viewer)) continue;
        if (routesOf(actionsFor(topic, viewer)).includes("/setup")) {
          expect(viewer.arkPlus, `${topic.id} offered /setup to a ${name}`).toBe(true);
        }
      }
    }
  });

  test("/account/* is only ever offered to a member", () => {
    for (const topic of supportTopics) {
      for (const [name, viewer] of VIEWERS) {
        if (topic.visibleWhen && !topic.visibleWhen(viewer)) continue;
        for (const to of routesOf(actionsFor(topic, viewer))) {
          if (!to.startsWith("/account")) continue;
          expect(viewer.signedIn, `${topic.id} offered ${to} to a ${name}`).toBe(true);
        }
      }
    }
  });

  test("/account/billing is only offered to someone who has a subscription", () => {
    // The route itself redirects anyone who isn't paying, guest or free.
    for (const topic of supportTopics) {
      for (const [name, viewer] of VIEWERS) {
        if (topic.visibleWhen && !topic.visibleWhen(viewer)) continue;
        if (routesOf(actionsFor(topic, viewer)).includes("/account/billing")) {
          expect(
            viewer.arkPlus || viewer.circle,
            `${topic.id} offered billing to a ${name}`,
          ).toBe(true);
        }
      }
    }
  });

  test("feed setup is hidden from a Circle-only member, who has no feed", () => {
    expect(visibleTopics(circle).map((t) => t.id)).not.toContain("feed-setup");
    expect(visibleTopics(arkPlus).map((t) => t.id)).toContain("feed-setup");
  });

  test("the bundle upsell shows to exactly one axis, never both and never none", () => {
    const shown = (v: SupportViewer) =>
      visibleTopics(v).map((t) => t.id).includes("upgrade-bundle");
    expect(shown(arkPlus)).toBe(true);
    expect(shown(circle)).toBe(true);
    expect(shown(bundle)).toBe(false);
    expect(shown(free)).toBe(false);
    expect(shown(guest)).toBe(false);
  });

  test("sign-in help is offered only to someone who isn't signed in", () => {
    expect(visibleTopics(guest).map((t) => t.id)).toContain("login-trouble");
    expect(visibleTopics(bundle).map((t) => t.id)).not.toContain("login-trouble");
  });

  test("a Fold member is sent to the Fold; someone without it is sold it", () => {
    const fold = supportTopicById.get("community-access")!;
    expect(routesOf(actionsFor(fold, bundle))).toContain("/fold");
    expect(actionsFor(fold, bundle).some((a) => a.kind === "external")).toBe(true);
    expect(actionsFor(fold, guest).some((a) => a.kind === "external")).toBe(false);
  });
});
