import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { AdminShell } from "../../components/AdminShell";
import { AdminListPanel, AdminTag, StatusPill } from "../../components/admin/AdminList";
import { listSupportSessions, type SupportSession } from "../../lib/admin";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { supportTopicById, type SupportIntentId } from "../../data/supportTopics";
import { formatTimestampWithTime } from "../../../shared/format-date";
import type { SupportStep, SupportStepKind } from "../../../shared/support";

export const Route = createFileRoute("/admin/support")({
  component: SupportAdmin,
});

const STEP_LABEL: Record<SupportStepKind, string> = {
  topic: "Topic",
  query: "Searched",
  no_results: "No answer",
  unanswerable: "Known gap",
  faq_opened: "Opened",
  link: "Followed",
  escalate: "Escalated",
};

/** Intent ids read as slugs in the log; show the label an admin recognises. */
function humanise(step: SupportStep): string {
  if (step.kind === "topic" || step.kind === "unanswerable") {
    return supportTopicById.get(step.value as SupportIntentId)?.label ?? step.value;
  }
  return step.value;
}

type Tally = { value: string; count: number };

function tally(sessions: SupportSession[], kind: SupportStepKind): Tally[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const s of sessions) {
    // Once per session, not once per step: someone retyping the same question
    // three times is one unanswered question, not three.
    const seen = new Set<string>();
    for (const step of s.steps) {
      if (step.kind !== kind) continue;
      const key = step.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { label: humanise(step), n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .map(({ label, n }) => ({ value: label, count: n }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function SupportAdmin() {
  const sessions = useAsyncResource(() => listSupportSessions(200), []);
  const rows = useMemo(() => sessions.data ?? [], [sessions.data]);

  // The whole reason the log exists. Everything else on this page is context
  // for reading these two lists.
  const unanswered = useMemo(() => tally(rows, "no_results"), [rows]);
  const knownGaps = useMemo(() => tally(rows, "unanswerable"), [rows]);
  const escalated = rows.filter((s) => s.escalated).length;

  const loading = sessions.status === "loading";
  const error = sessions.status === "error" ? "Could not load sessions." : null;

  return (
    <AdminShell active="support" title="Help widget">
      <p className="max-w-2xl text-body-sm text-fg-muted">
        What people asked the floating help widget. The list worth acting on is
        the first one: those are questions the FAQ corpus could not answer, and
        each is a candidate for a new entry in{" "}
        <Link to="/admin/faqs" className="text-cyan underline">
          FAQs
        </Link>
        . Sessions are kept for 180 days.
      </p>

      {error ? (
        <div className="mt-8">
          <p className="text-body-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={sessions.retry}
            className="mt-3 button-text font-bold text-cyan hover:underline"
          >
            Try again
          </button>
        </div>
      ) : null}

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-2">
        <TallyPanel
          title="Questions with no answer"
          ariaLabel="Queries that returned nothing"
          empty="Nothing yet — every search so far found something."
          loading={loading}
          error={error}
          items={unanswered}
        />
        <TallyPanel
          title="Known gaps people hit"
          ariaLabel="Questions the corpus deliberately does not answer"
          empty="Nobody has hit a known gap yet."
          loading={loading}
          error={error}
          items={knownGaps}
        />
      </div>

      <div className="mt-12">
        <AdminListPanel
          title={`Recent sessions${rows.length ? ` (${rows.length}, ${escalated} escalated)` : ""}`}
          ariaLabel="Recent help widget sessions"
          loading={loading}
          error={error}
          items={rows}
          emptyText="No sessions logged yet."
          renderItem={(s) => <SessionRow key={s.id} session={s} />}
        />
      </div>
    </AdminShell>
  );
}

function TallyPanel({
  title,
  ariaLabel,
  empty,
  loading,
  error,
  items,
}: {
  title: string;
  ariaLabel: string;
  empty: string;
  loading: boolean;
  error: string | null;
  items: Tally[];
}) {
  return (
    <AdminListPanel
      title={title}
      ariaLabel={ariaLabel}
      loading={loading}
      error={error}
      items={items}
      emptyText={empty}
      renderItem={(item) => (
        <li
          key={item.value}
          className="flex items-baseline justify-between gap-4 border border-rule p-3"
        >
          <span className="text-body-sm text-fg-strong">{item.value}</span>
          <span className="shrink-0 label font-bold text-cyan">
            {item.count}
          </span>
        </li>
      )}
    />
  );
}

function SessionRow({ session }: { session: SupportSession }) {
  return (
    <li className="border border-rule p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusPill
          tone={
            session.escalated
              ? "border-cyan/60 text-cyan"
              : "border-rule-strong text-fg-faint"
          }
        >
          {session.escalated ? "Escalated" : "Self-serve"}
        </StatusPill>
        <span className="text-body-sm text-fg-faint">
          {formatTimestampWithTime(session.createdAt)}
        </span>
      </div>

      <p className="mt-3 text-body-sm text-fg-muted">
        {session.email ? (
          <span className="text-fg-strong">{session.email}</span>
        ) : (
          "Signed out"
        )}
      </p>

      <ol className="mt-3 space-y-1">
        {session.steps.map((step, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-2 text-body-sm">
            <AdminTag>{STEP_LABEL[step.kind]}</AdminTag>
            <span className="text-fg">{humanise(step)}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}
