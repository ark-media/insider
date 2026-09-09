/// <reference types="bun" />
// The routing half of the help widget. Search quality is covered in
// src/lib/support/search.test.ts; what is asserted here is the promise the
// topic table makes about WHERE it sends people, which is the half that can
// send a paying member somewhere useless without anything looking broken.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  actionsFor,
  supportTopicById,
  supportTopics,
  topicVisible,
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

  test("nobody is sold what they already hold", () => {
    // Found in the browser, not in review: an unguarded "Add the Fold" rule was
    // offering a Bundle member the half they already pay for. `actionsFor`
    // returns EVERY matching rule, so an un-`when`-ed rule is not a fallback —
    // it is an always.
    for (const topic of supportTopics) {
      for (const [name, viewer] of VIEWERS) {
        if (topic.visibleWhen && !topic.visibleWhen(viewer)) continue;
        const actions = actionsFor(topic, viewer);
        if (viewer.arkPlus) {
          // /plus is the Ark+ pitch. Someone who holds Ark+ has read it.
          expect(routesOf(actions), `${topic.id} pitched /plus to a ${name}`).not.toContain("/plus");
        }
        if (viewer.circle) {
          expect(
            actions.map((a) => (a.kind === "route" ? a.label : "")),
            `${topic.id} pitched the Fold to a ${name}`,
          ).not.toContain("Add the Fold");
        }
      }
    }
  });

  test("a Bundle member — who owns everything — sees no upsell at all", () => {
    const fold = supportTopicById.get("community-access")!;
    const labels = actionsFor(fold, bundle).map((a) => (a.kind === "note" ? "" : a.label));
    expect(labels).toEqual(["Open the Fold", "Open in the app"]);

    const included = supportTopicById.get("whats-included")!;
    expect(routesOf(actionsFor(included, bundle))).toEqual(["/account"]);
  });

  test("a Fold member is sent to the Fold; someone without it is sold it", () => {
    const fold = supportTopicById.get("community-access")!;
    expect(routesOf(actionsFor(fold, bundle))).toContain("/fold");
    expect(actionsFor(fold, bundle).some((a) => a.kind === "external")).toBe(true);
    expect(actionsFor(fold, guest).some((a) => a.kind === "external")).toBe(false);
  });
});

/**
 * Every `to` in the topic table has to be a route that exists.
 *
 * Nothing else catches this. `navigate({ to: action.to as never })` in
 * SupportPanel erases the route-literal check at the one call site that would
 * have enforced it, so a topic can point at a deleted page and typecheck,
 * build, and render a button that dead-ends — which is exactly what happened
 * when /account/newsletters was folded into /account/settings.
 *
 * The route table is read as text rather than imported: importing
 * routeTree.gen.ts pulls in every page component (and a DOM) for what is a
 * question about strings.
 */
const ROUTE_PATHS: Set<string> = new Set(
  [...readFileSync("src/routeTree.gen.ts", "utf8").matchAll(/fullPath: '([^']+)'/g)].map(
    (m) => m[1],
  ),
);

describe("the topic table only links to routes that exist", () => {
  test("the route table was actually read", () => {
    // Guards the regex above: an empty set would make every case below vacuous.
    expect(ROUTE_PATHS.size).toBeGreaterThan(20);
    expect(ROUTE_PATHS.has("/account/settings")).toBe(true);
  });

  test("every topic action resolves, for every viewer", () => {
    const dangling: string[] = [];
    for (const topic of supportTopics) {
      for (const viewer of [guest, free, arkPlus, circle, bundle]) {
        for (const to of routesOf(actionsFor(topic, viewer))) {
          // Trailing-slash and index forms both appear in the generated table.
          if (!ROUTE_PATHS.has(to) && !ROUTE_PATHS.has(`${to}/`)) {
            dangling.push(`${topic.id} -> ${to}`);
          }
        }
      }
    }
    expect([...new Set(dangling)]).toEqual([]);
  });
});

describe("search reaches topics through the same gate the chips do", () => {
  test("a topic hidden from a viewer stays hidden however it is reached", () => {
    // The bug this pins: SupportPanel mapped search intents straight through
    // supportTopicById with no viewer gate, so a Bundle member who typed
    // "upgrade bundle" was offered the upsell `visibleWhen` exists to suppress.
    const upgrade = supportTopicById.get("upgrade-bundle")!;
    expect(topicVisible(upgrade, bundle)).toBe(false);
    expect(topicVisible(upgrade, arkPlus)).toBe(true);

    const login = supportTopicById.get("login-trouble")!;
    expect(topicVisible(login, guest)).toBe(true);
    expect(topicVisible(login, bundle)).toBe(false);
  });

  test("visibleTopics is exactly the chip-flagged half of topicVisible", () => {
    for (const viewer of [guest, free, arkPlus, circle, bundle]) {
      expect(visibleTopics(viewer)).toEqual(
        supportTopics.filter((t) => t.chip && topicVisible(t, viewer)),
      );
    }
  });
});

describe("escalate-only topics lead with the person", () => {
  test("the contact action is the primary one", () => {
    // `escalateOnly` documents itself as "escalation renders first", and
    // TopicView styles the first action as primary. Before actionsFor honoured
    // it, delete-account opened with "Read the privacy policy" — a link offered
    // in place of the person the topic says is required.
    const escalateOnly = supportTopics.filter((t) => t.escalateOnly);
    expect(escalateOnly.length).toBeGreaterThan(0);
    for (const topic of escalateOnly) {
      for (const viewer of [guest, free, arkPlus, circle, bundle]) {
        const actions = actionsFor(topic, viewer);
        if (actions.length === 0) continue;
        expect(actions[0].kind, `${topic.id} did not lead with contact`).toBe("contact");
      }
    }
  });

  test("a topic that is not escalate-only keeps its authored order", () => {
    const promo = supportTopicById.get("promo-code")!;
    expect(promo.escalateOnly).toBeUndefined();
    expect(actionsFor(promo, guest).map((a) => a.kind)).toEqual([
      "note",
      "route",
      "contact",
    ]);
  });
});
