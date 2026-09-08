import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { fetchFaqsOrThrow, type Faq } from "../../lib/faqs";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { viewerFrom } from "../../lib/support/viewer";
import {
  buildSupportIndex,
  searchSupport,
  type SupportSearchResult,
} from "../../lib/support/search";
import {
  aliasTextByFaqKey,
  supportAliases,
  supportUnanswerable,
} from "../../data/supportSynonyms";
import {
  actionsFor,
  supportTopicById,
  supportTopics,
  visibleTopics,
  SUPPORT_ESCALATION_TOPIC,
  type SupportAction,
  type SupportIntentId,
  type SupportTopic,
  type SupportViewer,
} from "../../data/supportTopics";
import {
  flushSupportLog,
  logSupportStep,
  writeSupportDraft,
} from "../../lib/support/session";
import type { ContactTopic } from "../../config/urls";
import { SupportAnswer } from "./SupportAnswer";

// Two views, not four. The plan's `results` and `answer` states collapse into
// disclosure rows here: on a ~360px panel that already scrolls, pushing a whole
// screen to read three sentences costs a round trip of navigation for nothing,
// and the answer reads better directly beneath the question it answers.
type View = { kind: "home" } | { kind: "topic"; id: SupportIntentId };

const MIN_QUERY = 2;
/** How long typing has to stop before the query is worth logging. */
const LOG_SETTLE_MS = 900;

const rowButton =
  "flex min-h-11 w-full items-start justify-between gap-3 py-3 text-left transition-colors hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan motion-reduce:transition-none";

const chipClass =
  "inline-flex min-h-11 items-center border border-rule-strong px-3 text-left text-body-sm text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan motion-reduce:transition-none";

const actionClass =
  "inline-flex min-h-11 w-full items-center justify-center border border-cyan bg-cyan px-4 button-text text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan motion-reduce:transition-none";

const actionSecondaryClass =
  "inline-flex min-h-11 w-full items-center justify-center border border-rule-strong px-4 button-text text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan motion-reduce:transition-none";

export function SupportPanel({ onClose }: { onClose: () => void }) {
  const { state, signIn } = useSubscriberAuth();
  const navigate = useNavigate();
  const viewer = useMemo(() => viewerFrom(state), [state]);

  // Deliberately not fetched until the panel mounts — the launcher is on every
  // page, and a widget nobody opened should cost nothing.
  const faqs = useAsyncResource(fetchFaqsOrThrow, []);

  const index = useMemo(
    () =>
      faqs.data ? buildSupportIndex(faqs.data, aliasTextByFaqKey(supportTopics)) : null,
    [faqs.data],
  );

  const faqByKey = useMemo(() => {
    const m = new Map<string, Faq>();
    for (const f of faqs.data ?? []) if (f.key) m.set(f.key, f);
    return m;
  }, [faqs.data]);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [stack, setStack] = useState<View[]>([{ kind: "home" }]);
  const view = stack[stack.length - 1];

  const result = useMemo<SupportSearchResult | null>(() => {
    if (!index || deferredQuery.trim().length < MIN_QUERY) return null;
    return searchSupport({
      index,
      query: deferredQuery,
      aliases: supportAliases,
      unanswerable: supportUnanswerable,
    });
  }, [index, deferredQuery]);

  // Log the query once typing settles, rather than once per keystroke — the
  // log's value is the list of questions that found nothing, and "h", "ho",
  // "how" are not three failed questions. Searched again here rather than
  // reusing `result` so what gets logged is the query that was actually typed,
  // not whatever the deferred render happened to be showing.
  const loggedQuery = useRef("");
  useEffect(() => {
    if (!index) return;
    const q = query.trim();
    if (q.length < MIN_QUERY) return;
    const timer = setTimeout(() => {
      if (loggedQuery.current === q) return;
      loggedQuery.current = q;
      const r = searchSupport({
        index,
        query: q,
        aliases: supportAliases,
        unanswerable: supportUnanswerable,
      });
      logSupportStep("query", q);
      if (r.kind === "unanswerable") logSupportStep("unanswerable", r.intents[0] ?? q);
      else if (r.kind === "no-match") logSupportStep("no_results", q);
    }, LOG_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [index, query]);

  // Which answer is expanded. Scoped to the current result set so that a
  // confident hit opens itself, a manual toggle sticks, and typing on lands you
  // on the next set's own default rather than a stale row id.
  const scope = view.kind === "topic" ? `t:${view.id}` : `q:${deferredQuery.trim()}`;
  const [open, setOpen] = useState<{ scope: string; id: string | null }>({
    scope: "",
    id: null,
  });
  const autoOpenId =
    view.kind === "home" && result?.kind === "confident"
      ? (result.hits[0]?.faq.id ?? null)
      : null;
  const openId = open.scope === scope ? open.id : autoOpenId;

  const toggleFaq = (faq: Faq) => {
    const next = openId === faq.id ? null : faq.id;
    setOpen({ scope, id: next });
    if (next) logSupportStep("faq_opened", faq.key ?? faq.id, faq.question);
  };

  const openTopic = (topic: SupportTopic) => {
    logSupportStep("topic", topic.id, topic.label);
    setStack((s) => [...s, { kind: "topic", id: topic.id }]);
  };

  const escalate = (topic: ContactTopic) => {
    logSupportStep("escalate", topic);
    writeSupportDraft(topic);
    void flushSupportLog();
    onClose();
    void navigate({ to: "/contact", search: { topic } });
  };

  const runAction = (action: SupportAction) => {
    switch (action.kind) {
      case "route":
        logSupportStep("link", action.to, action.label);
        void flushSupportLog();
        onClose();
        void navigate({ to: action.to as never, search: action.search as never });
        return;
      case "external":
        logSupportStep("link", action.href, action.label);
        void flushSupportLog();
        window.open(action.href, "_blank", "noopener,noreferrer");
        return;
      case "signIn":
        logSupportStep("link", "sign-in", action.label);
        void flushSupportLog();
        onClose();
        signIn();
        return;
      case "contact":
        escalate(action.topic);
        return;
      case "note":
        return;
    }
  };

  const chips = useMemo(() => visibleTopics(viewer), [viewer]);
  const searchable = index !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* --- Search ------------------------------------------------------ */}
      <div className="border-b border-rule px-4 py-3">
        {view.kind === "topic" ? (
          <button
            type="button"
            onClick={() => setStack((s) => s.slice(0, -1))}
            className="inline-flex min-h-11 items-center gap-2 button-text text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <span aria-hidden="true">←</span> All topics
          </button>
        ) : (
          <form onSubmit={(e) => e.preventDefault()} role="search">
            <label htmlFor="support-query" className="sr-only">
              Search the help answers
            </label>
            <input
              id="support-query"
              type="search"
              autoComplete="off"
              enterKeyHint="search"
              disabled={!searchable}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                faqs.status === "loading" ? "Loading answers…" : "Ask a question"
              }
              className="min-h-11 w-full border border-rule-strong bg-transparent px-3 py-2 text-body-sm text-fg-strong outline-none transition placeholder:text-fg-placeholder focus:border-cyan disabled:opacity-60"
            />
          </form>
        )}
      </div>

      {/* --- Body -------------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {view.kind === "topic" ? (
          <TopicView
            topic={supportTopicById.get(view.id)}
            viewer={viewer}
            faqByKey={faqByKey}
            openId={openId}
            onToggle={toggleFaq}
            onAction={runAction}
          />
        ) : (
          <HomeView
            faqsFailed={faqs.status === "error"}
            onRetry={faqs.retry}
            query={deferredQuery}
            result={result}
            chips={chips}
            openId={openId}
            onToggle={toggleFaq}
            onOpenTopic={openTopic}
          />
        )}
      </div>

      {/* --- Escalation, reachable from every state ----------------------- */}
      <div className="border-t border-rule px-4 py-3">
        <button
          type="button"
          onClick={() => escalate(SUPPORT_ESCALATION_TOPIC)}
          className={actionSecondaryClass}
        >
          Talk to a person
        </button>
      </div>
    </div>
  );
}

// --- Home ------------------------------------------------------------------

function HomeView({
  faqsFailed,
  onRetry,
  query,
  result,
  chips,
  openId,
  onToggle,
  onOpenTopic,
}: {
  faqsFailed: boolean;
  onRetry: () => void;
  query: string;
  result: SupportSearchResult | null;
  chips: SupportTopic[];
  openId: string | null;
  onToggle: (faq: Faq) => void;
  onOpenTopic: (topic: SupportTopic) => void;
}) {
  if (faqsFailed) {
    return (
      <div>
        <p className="text-body-sm text-fg-muted">
          The answers didn&rsquo;t load. Browse the topics below, or try again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className={`mt-3 ${actionSecondaryClass}`}
        >
          Try again
        </button>
        <TopicChips chips={chips} onOpen={onOpenTopic} className="mt-6" />
      </div>
    );
  }

  if (!result || query.trim().length < MIN_QUERY) {
    return (
      <div>
        <p className="text-body-sm text-fg-muted">
          Search the answers, or pick a topic.
        </p>
        <TopicChips chips={chips} onOpen={onOpenTopic} className="mt-4" />
      </div>
    );
  }

  const intentTopics = result.intents
    .map((id) => supportTopicById.get(id as SupportIntentId))
    .filter((t): t is SupportTopic => Boolean(t));

  // The corpus provably has no answer here, so no FAQ is shown at all — not
  // even a plausible-looking one. This is the single most valuable branch in
  // the widget: "how do I get a refund" ranks perfectly well against the
  // cancellation answer, and sending it there is both wrong and expensive.
  if (result.kind === "unanswerable") {
    return (
      <div>
        <p className="text-body-sm text-fg-muted">
          {intentTopics[0]?.blurb ?? "That one needs a person."}
        </p>
        <TopicList topics={intentTopics} onOpen={onOpenTopic} className="mt-4" />
      </div>
    );
  }

  if (result.kind === "no-match") {
    return (
      <div>
        <p className="text-body-sm text-fg-muted">
          I couldn&rsquo;t find an answer for that.
        </p>
        {intentTopics.length > 0 ? (
          <TopicList topics={intentTopics} onOpen={onOpenTopic} className="mt-4" />
        ) : (
          <TopicChips chips={chips} onOpen={onOpenTopic} className="mt-4" />
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="eyebrow text-cyan">
        {result.kind === "confident" ? "This should answer it" : "These might help"}
      </p>
      <FaqRows
        faqs={result.hits.map((h) => h.faq)}
        openId={openId}
        onToggle={onToggle}
        className="mt-2"
      />
      {intentTopics.length > 0 ? (
        <TopicList topics={intentTopics} onOpen={onOpenTopic} className="mt-5" />
      ) : null}
    </div>
  );
}

// --- Topic -----------------------------------------------------------------

function TopicView({
  topic,
  viewer,
  faqByKey,
  openId,
  onToggle,
  onAction,
}: {
  topic: SupportTopic | undefined;
  viewer: SupportViewer;
  faqByKey: Map<string, Faq>;
  openId: string | null;
  onToggle: (faq: Faq) => void;
  onAction: (action: SupportAction) => void;
}) {
  if (!topic) {
    return <p className="text-body-sm text-fg-muted">That topic has moved.</p>;
  }

  const actions = actionsFor(topic, viewer);
  // A key that resolves to nothing is not an error: an admin can retire an FAQ
  // at any time, and the widget's job is to carry on with what is left.
  const faqs = topic.faqKeys
    .map((k) => faqByKey.get(k))
    .filter((f): f is Faq => Boolean(f));

  return (
    <div>
      <h3 className="font-display text-[17px] leading-snug text-fg-strong">
        {topic.label}
      </h3>
      <p className="mt-1 text-body-sm text-fg-muted">{topic.blurb}</p>

      {actions.length > 0 ? (
        <div className="mt-4 space-y-2">
          {actions.map((action, i) =>
            action.kind === "note" ? (
              <p key={i} className="text-body-sm text-fg">
                {action.body}
              </p>
            ) : (
              <button
                key={i}
                type="button"
                onClick={() => onAction(action)}
                className={i === 0 ? actionClass : actionSecondaryClass}
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}

      {faqs.length > 0 ? (
        <div className="mt-6">
          <p className="eyebrow text-cyan">Related answers</p>
          <FaqRows
            faqs={faqs}
            openId={openId}
            onToggle={onToggle}
            className="mt-2"
          />
        </div>
      ) : null}
    </div>
  );
}

// --- Shared pieces ---------------------------------------------------------

function FaqRows({
  faqs,
  openId,
  onToggle,
  className = "",
}: {
  faqs: Faq[];
  openId: string | null;
  onToggle: (faq: Faq) => void;
  className?: string;
}) {
  return (
    <ul className={`border-t border-rule ${className}`}>
      {faqs.map((faq) => {
        const isOpen = openId === faq.id;
        const panelId = `support-answer-${faq.id}`;
        return (
          <li key={faq.id} className="border-b border-rule">
            <button
              type="button"
              onClick={() => onToggle(faq)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              className={rowButton}
            >
              <span
                className={`text-body-sm leading-snug ${
                  isOpen ? "text-cyan" : "text-fg-strong"
                }`}
              >
                {faq.question}
              </span>
              <span
                aria-hidden="true"
                className={`shrink-0 text-[16px] leading-none transition-transform duration-300 motion-reduce:transition-none ${
                  isOpen ? "rotate-45 text-cyan" : "text-fg-faint"
                }`}
              >
                +
              </span>
            </button>
            <div id={panelId} role="region" inert={!isOpen} hidden={!isOpen}>
              <div className="pb-4">
                <SupportAnswer faq={faq} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function TopicChips({
  chips,
  onOpen,
  className = "",
}: {
  chips: SupportTopic[];
  onOpen: (topic: SupportTopic) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {chips.map((topic) => (
        <button
          key={topic.id}
          type="button"
          onClick={() => onOpen(topic)}
          className={chipClass}
        >
          {topic.label}
        </button>
      ))}
    </div>
  );
}

function TopicList({
  topics,
  onOpen,
  className = "",
}: {
  topics: SupportTopic[];
  onOpen: (topic: SupportTopic) => void;
  className?: string;
}) {
  if (topics.length === 0) return null;
  return (
    <div className={className}>
      <p className="eyebrow text-cyan">Go straight to</p>
      <div className="mt-2 flex flex-col gap-2">
        {topics.map((topic) => (
          <button
            key={topic.id}
            type="button"
            onClick={() => onOpen(topic)}
            className={`${chipClass} justify-start`}
          >
            {topic.label}
          </button>
        ))}
      </div>
    </div>
  );
}
