/// <reference types="bun" />
// The widget's session log and the handoff it hands to /contact.
//
// Both are best-effort by design — a log that fails must never stop the widget
// from helping someone — so the interesting assertions are about what survives
// (the questions that found no answer) and what does not leak (the client-only
// `label`, a stale draft from a visit that ended an hour ago).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const g = globalThis as unknown as { document?: unknown; fetch: typeof fetch };
const realFetch = g.fetch;
if (!g.document) {
  GlobalRegistrator.register();
  g.fetch = realFetch;
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SUPPORT_MAX_STEPS, type SupportStep } from "../../../shared/support";
import {
  beaconSupportLog,
  flushSupportLog,
  logSupportStep,
  resetSupportSession,
  supportSessionId,
  supportSteps,
  supportTranscript,
  SUPPORT_DRAFT_EVENT,
  takeSupportDraft,
  writeSupportDraft,
} from "./session";

type Posted = { url: string; body: { sessionId: string; steps: SupportStep[] } };
let posts: Posted[] = [];

beforeEach(() => {
  resetSupportSession();
  posts = [];
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Posted["body"],
    });
    return Response.json({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  resetSupportSession();
  g.fetch = realFetch;
});

describe("session id", () => {
  test("is stable within a session and passes the server's format check", () => {
    const id = supportSessionId();
    expect(supportSessionId()).toBe(id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  test("survives a reload, so a re-post doesn't overwrite the row's history", () => {
    // The server REPLACES `steps` on upsert. A buffer that forgot what came
    // before would silently truncate the session to whatever happened after
    // the reload, which is the half that matters least.
    logSupportStep("query", "cancel");
    const id = supportSessionId();

    resetInMemoryOnly();
    expect(supportSessionId()).toBe(id);
    expect(supportSteps().map((s) => s.value)).toEqual(["cancel"]);
  });
});

// Drops the module's in-memory mirror without touching sessionStorage — what a
// page reload does.
function resetInMemoryOnly() {
  const saved = window.sessionStorage.getItem("ark.support.session");
  resetSupportSession();
  if (saved) window.sessionStorage.setItem("ark.support.session", saved);
}

describe("logSupportStep", () => {
  test("collapses consecutive duplicates", () => {
    logSupportStep("faq_opened", "cancel-anytime");
    logSupportStep("faq_opened", "cancel-anytime");
    logSupportStep("faq_opened", "annual-discount");
    logSupportStep("faq_opened", "cancel-anytime");
    expect(supportSteps().map((s) => s.value)).toEqual([
      "cancel-anytime",
      "annual-discount",
      "cancel-anytime",
    ]);
  });

  test("ignores an empty value", () => {
    logSupportStep("query", "   ");
    expect(supportSteps()).toEqual([]);
  });

  test("keeps the MOST RECENT steps at the cap", () => {
    for (let i = 0; i < SUPPORT_MAX_STEPS + 5; i += 1) {
      logSupportStep("query", `q${i}`);
    }
    const values = supportSteps().map((s) => s.value);
    expect(values.length).toBe(SUPPORT_MAX_STEPS);
    // The tail is where someone gave up, and the escalate step that flips the
    // row's `escalated` flag is always last.
    expect(values.at(-1)).toBe(`q${SUPPORT_MAX_STEPS + 4}`);
  });
});

describe("flush", () => {
  test("posts the session and strips the client-only label", async () => {
    logSupportStep("faq_opened", "cancel-anytime", "Can I cancel at any time?");
    await flushSupportLog();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/support/log");
    expect(posts[0].body.sessionId).toBe(supportSessionId());
    expect(posts[0].body.steps).toEqual([
      {
        at: expect.any(String),
        kind: "faq_opened",
        value: "cancel-anytime",
      },
    ]);
  });

  test("says nothing when there is nothing to say", async () => {
    await flushSupportLog();
    expect(posts).toHaveLength(0);
  });

  test("a failed post is swallowed — logging never breaks the widget", async () => {
    g.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    logSupportStep("query", "cancel");
    await flushSupportLog();
    expect(supportSteps()).toHaveLength(1);
  });

  test("the beacon path is a no-op when nothing has happened", () => {
    let beacons = 0;
    (navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => {
      beacons += 1;
      return true;
    };
    beaconSupportLog();
    expect(beacons).toBe(0);

    logSupportStep("query", "cancel");
    beaconSupportLog();
    expect(beacons).toBe(1);
  });
});

describe("transcript", () => {
  test("reads as a summary for a person, using the FAQ's question", () => {
    logSupportStep("query", "how do I cancel");
    logSupportStep("faq_opened", "cancel-anytime", "Can I cancel my subscription at any time?");
    logSupportStep("query", "refund");
    logSupportStep("no_results", "refund");

    const t = supportTranscript();
    // "refund" appears only under the line that says it found nothing — a
    // question is not both a search and a separate failure.
    expect(t).toContain("Looked for: “how do I cancel”");
    expect(t).not.toContain("Looked for: “how do I cancel”, “refund”");
    // The slug is what the log stores; a human gets the question.
    expect(t).toContain("Can I cancel my subscription at any time?");
    expect(t).not.toContain("cancel-anytime");
    expect(t).toContain("Found no answer for: “refund”");
  });

  test("summarises rather than transcribes, and stays well under MESSAGE_MAX", () => {
    for (let i = 0; i < 12; i += 1) logSupportStep("query", `question number ${i}`);
    const t = supportTranscript();
    expect(t).toContain("(+9 more)");
    expect(t.length).toBeLessThan(1500);
  });

  test("carries the guided path, where nothing was ever typed", () => {
    // Chips only: no query, no opened answer. Dropping topics here handed the
    // support desk a completely blank transcript for the guided half of the
    // widget — which is most of it.
    logSupportStep("topic", "cancel", "Cancel or change my plan");
    expect(supportTranscript()).toContain("Looking at: “Cancel or change my plan”");
  });

  test("is empty when the member opened the widget and went straight to us", () => {
    expect(supportTranscript()).toBe("");
  });
});

describe("handoff draft", () => {
  test("round-trips, and clears so Back doesn't refill a sent form", () => {
    logSupportStep("query", "double charged");
    writeSupportDraft("support");

    const draft = takeSupportDraft();
    expect(draft?.topic).toBe("support");
    expect(draft?.message).toContain("double charged");
    // The member's own words come first; the context sits underneath.
    expect(draft?.message.startsWith("\n\n")).toBe(true);

    expect(takeSupportDraft()).toBeNull();
  });

  test("a draft from an abandoned visit is dropped, not resurrected", () => {
    writeSupportDraft("support");
    const raw = JSON.parse(window.sessionStorage.getItem("ark.support.draft")!) as {
      at: number;
    };
    window.sessionStorage.setItem(
      "ark.support.draft",
      JSON.stringify({ ...raw, at: Date.now() - 60 * 60 * 1000 }),
    );
    expect(takeSupportDraft()).toBeNull();
  });

  test("a corrupt draft is ignored rather than thrown", () => {
    window.sessionStorage.setItem("ark.support.draft", "{not json");
    expect(takeSupportDraft()).toBeNull();
  });

  test("announces itself, so a /contact already on screen picks it up", () => {
    // Escalating from the widget navigates to /contact — but a member standing
    // on /contact already gets a search-param-only change on a matched route,
    // which does not remount the page. Without this event its mount-time read
    // never re-runs: the transcript is dropped and the unread draft ambushes
    // some later visit instead.
    // Collected rather than assigned to a `let`: the assertions below sit
    // outside the callback, where TS would narrow a `let` to its initializer.
    const readAtFireTime: (string | null)[] = [];
    const onDraft = () => {
      readAtFireTime.push(takeSupportDraft()?.message ?? null);
    };
    window.addEventListener(SUPPORT_DRAFT_EVENT, onDraft);
    try {
      logSupportStep("query", "double charged");
      writeSupportDraft("support");
    } finally {
      window.removeEventListener(SUPPORT_DRAFT_EVENT, onDraft);
    }

    expect(readAtFireTime).toHaveLength(1);
    // Fired AFTER the write, so the listener finds a draft rather than a race.
    expect(readAtFireTime[0]).toContain("double charged");
  });
});
