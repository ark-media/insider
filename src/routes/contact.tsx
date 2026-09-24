import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "../components/PageShell";
import { contactTopics, type ContactTopic } from "../config/urls";
import {
  getShow,
  isListenerQuestionShow,
  listenerQuestionShows,
  type ListenerQuestionShow,
} from "../data/shows";
import { sendContactMessage } from "../lib/contact";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import {
  SUPPORT_DRAFT_EVENT,
  takeSupportDraft,
} from "../lib/support/session";

export const Route = createFileRoute("/contact")({
  // Allow a topic to be pre-selected via ?topic=… (e.g. links that want the
  // form to open on a specific desk), and a listener question's show via
  // ?show=… (a show page linking to its own question box). Unknown/missing
  // values fall through to the form's defaults. Only known values are accepted.
  validateSearch: (
    search,
  ): { topic?: ContactTopic; show?: ListenerQuestionShow } => {
    const t = search.topic;
    const s = search.show;
    return {
      ...(typeof t === "string" && contactTopics.some((x) => x.value === t)
        ? { topic: t as ContactTopic }
        : {}),
      ...(isListenerQuestionShow(s) ? { show: s } : {}),
    };
  },
  component: ContactPage,
});

const inputClass =
  "min-h-11 w-full border border-rule-strong bg-transparent px-3 py-2 text-body text-fg-strong outline-none transition placeholder:text-fg-muted focus:border-cyan";
const labelClass =
  "label text-cyan";

function ContactPage() {
  const { topic: topicParam, show: showParam } = Route.useSearch();
  const { state } = useSubscriberAuth();

  // Name and email are DERIVED, not copied: null means "the member hasn't
  // touched this field", so a signed-in member sees their own details without
  // an effect that races /api/me resolving after mount. Typing anything (an
  // empty string included) takes ownership of the field from then on.
  const me = state.kind === "member" ? state.me : null;
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState<string | null>(null);
  // The greeting rule from shared/profile-name.ts holds here too: a name we
  // were never given stays blank rather than being invented from the email.
  const name = nameInput ?? me?.firstName ?? "";
  const email = emailInput ?? me?.email ?? "";

  const [topic, setTopic] = useState<ContactTopic>(
    topicParam ?? contactTopics[0].value,
  );
  const [message, setMessage] = useState("");
  // No default: a listener question has to name its show, and preselecting
  // one would quietly file every unconsidered question under it.
  const [show, setShow] = useState<ListenerQuestionShow | "">(showParam ?? "");

  // Handoff from the help widget: it stashes a short transcript in
  // sessionStorage and navigates here with the desk already preselected.
  //
  // This is a read from an external system that also CLEARS it, so it can't be
  // derived during render and it can't be a useState initializer (StrictMode
  // double-invokes those, and the second call would find the draft already
  // gone). Clearing is the point: a member who sends this and then hits Back
  // should not find the transcript sitting in the form again.
  //
  // Reading-and-clearing an external store is the external-system
  // synchronisation the set-state-in-effect rule carves out.
  //
  // Both inputs to the desk are settled here, in one effect, because they are
  // one decision and they arrive together. Escalating from the widget while
  // already standing on /contact changes only the search param on a matched
  // route: TanStack updates the params without remounting, so neither a
  // mount-only draft read nor a `useState` initializer for `topic` would fire.
  // Hence ?topic=… (and ?show=…) is treated as a live input, and the widget announces the
  // draft with an event — otherwise the transcript sits in sessionStorage and
  // ambushes some later visit.
  //
  // The draft is applied SECOND and wins. Today the two always agree (the
  // widget navigates with the same topic it stashes), but the draft is the
  // more specific signal — it is the desk chosen for this transcript — and
  // relying on them agreeing is the kind of coupling that quietly stops
  // holding.
  useEffect(() => {
    const applyDraft = () => {
      const draft = takeSupportDraft();
      if (!draft?.message) return;
      setMessage(draft.message);
      if (draft.topic) setTopic(draft.topic);
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (topicParam) setTopic(topicParam);
    if (showParam) setShow(showParam);
    applyDraft();
    window.addEventListener(SUPPORT_DRAFT_EVENT, applyDraft);
    return () => window.removeEventListener(SUPPORT_DRAFT_EVENT, applyDraft);
  }, [topicParam, showParam]);

  // Honeypot — see server/routes/contact.ts. Real users leave it blank.
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "ok" | "error">(
    "idle",
  );
  const [feedback, setFeedback] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (company.trim() !== "") return; // bot tripped the honeypot
    setStatus("submitting");
    setFeedback(null);
    const r = await sendContactMessage({ name, email, topic, show, message });
    if (r.ok) {
      setStatus("ok");
      setFeedback("Thanks — your message is on its way. We'll be in touch.");
      // Back to derived: a signed-in member sees their details again, a
      // signed-out one sees a blank form.
      setNameInput(null);
      setEmailInput(null);
      setMessage("");
      setTopic(contactTopics[0].value);
      setShow("");
    } else {
      setStatus("error");
      setFeedback(r.error ?? "Could not send. Please try again.");
    }
  };

  return (
    <PageShell
      title="Get in touch."
      lede="Send us a note and it'll reach the right desk. Pick a topic, tell us what's on your mind, and we'll follow up by email."
    >
      <section>
        <div className="mx-auto max-w-[680px] px-6 py-16 sm:px-10">
          <form
            onSubmit={onSubmit}
            className="border border-rule bg-navy-800/40 p-6 sm:p-8"
          >
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <label className="block">
                <span className={labelClass}>Name</span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Your name"
                  className={`mt-3 ${inputClass}`}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="you@example.com"
                  className={`mt-3 ${inputClass}`}
                />
              </label>
            </div>

            <label className="mt-6 block">
              <span className={labelClass}>Topic</span>
              <select
                value={topic}
                onChange={(e) => setTopic(e.target.value as ContactTopic)}
                className={`mt-3 ${inputClass} select-chevron`}
              >
                {contactTopics.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            {topic === "questions" ? (
              <label className="mt-6 block">
                <span className={labelClass}>Show</span>
                <select
                  required
                  value={show}
                  onChange={(e) =>
                    setShow(e.target.value as ListenerQuestionShow | "")
                  }
                  className={`mt-3 ${inputClass} select-chevron`}
                >
                  <option value="" disabled>
                    Which show is your question for?
                  </option>
                  {listenerQuestionShows.map((slug) => (
                    <option key={slug} value={slug}>
                      {getShow(slug)?.title ?? slug}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="mt-6 block">
              <span className={labelClass}>Message</span>
              <textarea
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What's on your mind?"
                rows={6}
                className={`mt-3 ${inputClass} resize-y`}
              />
            </label>

            {/* Honeypot: visually hidden, off the tab order, ignored by humans. */}
            <div aria-hidden className="hidden">
              <label>
                Company
                <input
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </label>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <button
                type="submit"
                disabled={status === "submitting"}
                className="min-h-11 bg-cyan px-6 py-2 button-text text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
              >
                {status === "submitting" ? "Sending…" : "Send message"}
              </button>
              {feedback ? (
                <p
                  className={`text-body-sm ${
                    status === "error" ? "text-danger" : "text-cyan"
                  }`}
                  aria-live="polite"
                >
                  {feedback}
                </p>
              ) : null}
            </div>
          </form>
        </div>
      </section>
    </PageShell>
  );
}
