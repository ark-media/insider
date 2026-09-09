// Session log + escalation handoff for the help widget.
//
// Two jobs that share one buffer:
//
//   * The LOG (POST /api/support/log) — an analytics artifact. Its point is not
//     the transcript; it is the list of questions that returned nothing, which
//     is the content backlog for /admin/faqs.
//   * The HANDOFF (sessionStorage → /contact) — a support-desk artifact. A
//     human reads this, so it wants the FAQ's question text, not its slug.
//
// Steps therefore carry an optional `label`: the wire `value` stays the stable
// id the log wants, while `label` carries the human string the transcript
// wants. `label` is stripped before the POST — the server would ignore it, and
// sending a field the contract doesn't name invites someone to start depending
// on it.

import {
  SUPPORT_MAX_STEPS,
  SUPPORT_MAX_VALUE_LENGTH,
  type SupportStep,
  type SupportStepKind,
} from "../../../shared/support";
import type { ContactTopic } from "../../config/urls";

const STORE_KEY = "ark.support.session";
const DRAFT_KEY = "ark.support.draft";

/** Long enough that a burst of taps is one write, short enough to survive a tab close. */
const FLUSH_DELAY_MS = 1500;

/** A handoff older than this belongs to a different visit — drop it. */
const DRAFT_MAX_AGE_MS = 30 * 60 * 1000;

type TrailStep = SupportStep & { label?: string };
type Stored = { id: string; steps: TrailStep[] };

// sessionStorage access itself throws in some private modes, so every touch is
// guarded (the pattern src/lib/attribution.ts already uses).
function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function newSessionId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  // Must satisfy the server's /^[A-Za-z0-9_-]{8,}$/ without a UUID source.
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Mirrored in memory so the common path costs nothing, and so a session still
// works when storage is unavailable. Storage is what carries the buffer across
// a reload: the server REPLACES `steps` on upsert, so a buffer that forgot its
// history would overwrite the row with only its tail.
let state: Stored | null = null;

function load(): Stored {
  if (state) return state;
  const s = store();
  try {
    const raw = s?.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored>;
      if (typeof parsed?.id === "string" && Array.isArray(parsed.steps)) {
        state = { id: parsed.id, steps: parsed.steps };
        return state;
      }
    }
  } catch {
    /* corrupt or unavailable — start fresh */
  }
  state = { id: newSessionId(), steps: [] };
  save();
  return state;
}

function save(): void {
  const s = store();
  if (!s || !state) return;
  try {
    s.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — the in-memory buffer still works */
  }
}

export function supportSessionId(): string {
  return load().id;
}

/** The steps so far, oldest first. Read by the transcript builder and tests. */
export function supportSteps(): TrailStep[] {
  return load().steps;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Record one step. Consecutive duplicates collapse — re-opening the same answer
 * or retyping the same query says nothing new and would spend the 50-step cap.
 */
export function logSupportStep(
  kind: SupportStepKind,
  value: string,
  label?: string,
): void {
  const trimmed = value.trim().slice(0, SUPPORT_MAX_VALUE_LENGTH);
  if (!trimmed) return;

  const s = load();
  const last = s.steps[s.steps.length - 1];
  if (last && last.kind === kind && last.value === trimmed) return;

  s.steps.push({ at: new Date().toISOString(), kind, value: trimmed, label });
  // Keep the MOST RECENT steps: the tail is where someone gave up, and the
  // escalate step that flips the row's `escalated` flag is always last.
  if (s.steps.length > SUPPORT_MAX_STEPS) {
    s.steps = s.steps.slice(-SUPPORT_MAX_STEPS);
  }
  save();

  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushSupportLog(), FLUSH_DELAY_MS);
}

function payload(): string | null {
  const s = load();
  if (s.steps.length === 0) return null;
  return JSON.stringify({
    sessionId: s.id,
    steps: s.steps.map(({ at, kind, value }) => ({ at, kind, value })),
  });
}

/**
 * Send what we have. Never throws and never reports failure to the caller:
 * logging is a side benefit of the widget, not a dependency of it, and an
 * escalation must navigate whether or not the write landed.
 */
export async function flushSupportLog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const body = payload();
  if (!body) return;
  try {
    await fetch("/api/support/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body,
    });
  } catch {
    /* offline, blocked, rate-limited — the widget carries on regardless */
  }
}

/**
 * Last-chance flush on tab close. `fetch` is abandoned when the document goes
 * away; sendBeacon is queued by the browser and survives it. Same-origin, so
 * no preflight — the endpoint's origin check sees the page's own origin.
 */
export function beaconSupportLog(): void {
  const body = payload();
  if (!body) return;
  try {
    const beacon = navigator.sendBeacon?.bind(navigator);
    if (beacon) {
      beacon("/api/support/log", new Blob([body], { type: "application/json" }));
    }
  } catch {
    /* best effort */
  }
}

// --- Escalation handoff ---------------------------------------------------

export type SupportDraft = {
  topic: ContactTopic;
  message: string;
  /** Epoch ms, so a stale draft from an abandoned visit can be dropped. */
  at: number;
};

/**
 * A transcript for a person to read — a few lines of what was tried, not a
 * verbatim log. Kept far below the 5000-char MESSAGE_MAX the contact endpoint
 * enforces, because a support desk wants the shape of the problem and the
 * member still has to be able to edit around it.
 */
export function supportTranscript(): string {
  const steps = supportSteps();
  const topics: string[] = [];
  const searched: string[] = [];
  const read: string[] = [];
  const stuck: string[] = [];

  const add = (list: string[], text: string) => {
    if (!list.includes(text)) list.push(text);
  };

  for (const step of steps) {
    // `label` is the human string the panel knew (a topic's label, an FAQ's
    // question); `value` is the slug the log stores. A support desk wants the
    // former — a transcript reading "cancel-anytime" helps nobody.
    const text = (step.label ?? step.value).slice(0, 120);
    // Topics are not decoration here: someone who tapped their way through the
    // chips and never typed anything has NO query and NO opened answer, and
    // dropping their topics handed the desk a blank transcript — which is the
    // whole guided path.
    if (step.kind === "topic") add(topics, text);
    else if (step.kind === "query") add(searched, text);
    else if (step.kind === "faq_opened") add(read, text);
    else if (step.kind === "no_results" || step.kind === "unanswerable") {
      add(stuck, text);
    }
  }

  // A question that found nothing is reported once, under the line that says
  // so — not twice, once as a search and again as a failure.
  const onlySearched = searched.filter((q) => !stuck.includes(q));

  const lines: string[] = [];
  if (topics.length) lines.push(`Looking at: ${quoteList(topics)}`);
  if (onlySearched.length) lines.push(`Looked for: ${quoteList(onlySearched)}`);
  if (read.length) lines.push(`Read: ${quoteList(read)}`);
  if (stuck.length) lines.push(`Found no answer for: ${quoteList(stuck)}`);
  if (lines.length === 0) return "";

  return ["— From the help widget —", ...lines].join("\n").slice(0, 1200);
}

function quoteList(items: string[]): string {
  // Three is the point at which a list stops being a summary.
  const shown = items.slice(0, 3).map((s) => `“${s}”`);
  const extra = items.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

/**
 * Fired after a handoff is stashed, so a /contact page that is ALREADY mounted
 * picks it up.
 *
 * Escalating from the widget navigates to /contact, but when the member is
 * standing on /contact already that is a search-param-only change on a matched
 * route: TanStack updates the params without remounting, the mount-time read
 * never re-runs, and the transcript sits unread in sessionStorage until it
 * ambushes some later visit. The event closes that gap without making the
 * stored draft a reactive store.
 */
export const SUPPORT_DRAFT_EVENT = "ark:support-draft";

export function writeSupportDraft(topic: ContactTopic): void {
  const transcript = supportTranscript();
  const draft: SupportDraft = {
    topic,
    // Two leading newlines so the member's own words come first and the
    // context sits underneath, rather than the form opening with a wall of
    // machine text they have to delete.
    message: transcript ? `\n\n${transcript}` : "",
    at: Date.now(),
  };
  try {
    store()?.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* the /contact form still works, just without the prefill */
  }
  try {
    window.dispatchEvent(new Event(SUPPORT_DRAFT_EVENT));
  } catch {
    /* non-DOM host; the mount-time read still covers the normal case */
  }
}

/** Reads the handoff and clears it, so a back-button return doesn't re-fill. */
export function takeSupportDraft(): SupportDraft | null {
  const s = store();
  if (!s) return null;
  let raw: string | null = null;
  try {
    raw = s.getItem(DRAFT_KEY);
    s.removeItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<SupportDraft>;
    if (typeof d?.message !== "string" || typeof d.at !== "number") return null;
    if (Date.now() - d.at > DRAFT_MAX_AGE_MS) return null;
    return { topic: (d.topic ?? "support") as ContactTopic, message: d.message, at: d.at };
  } catch {
    return null;
  }
}

/** Test seam — drops the in-memory buffer and its stored mirror. */
export function resetSupportSession(): void {
  state = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    store()?.removeItem(STORE_KEY);
    store()?.removeItem(DRAFT_KEY);
  } catch {
    /* nothing to clear */
  }
}
