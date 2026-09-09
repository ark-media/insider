import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "../components/PageShell";
import { contactTopics, type ContactTopic } from "../config/urls";
import { sendContactMessage } from "../lib/contact";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import {
  SUPPORT_DRAFT_EVENT,
  takeSupportDraft,
} from "../lib/support/session";

export const Route = createFileRoute("/contact")({
  // Allow a topic to be pre-selected via ?topic=… (e.g. links that want the
  // form to open on a specific desk). Unknown/missing values fall through to
  // the form's default. Only known topic values are accepted.
  validateSearch: (search): { topic?: ContactTopic } => {
    const t = search.topic;
    return typeof t === "string" && contactTopics.some((x) => x.value === t)
      ? { topic: t as ContactTopic }
      : {};
  },
  component: ContactPage,
});

const inputClass =
  "min-h-11 w-full border border-rule-strong bg-transparent px-3 py-2 text-body text-fg-strong outline-none transition placeholder:text-fg-muted focus:border-cyan";
const labelClass =
  "label text-cyan";

function ContactPage() {
  const { topic: topicParam } = Route.useSearch();
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
  // Read on mount AND on the widget's event: escalating while already standing
  // on /contact only changes the search param, so this component is not
  // remounted and the mount read alone would drop the transcript on the floor —
  // leaving it in sessionStorage to ambush some later visit instead.
  useEffect(() => {
    const apply = () => {
      const draft = takeSupportDraft();
      if (!draft?.message) return;
      setMessage(draft.message);
      // The desk the widget picked, which the search param alone won't apply
      // when the route doesn't remount.
      if (draft.topic) setTopic(draft.topic);
    };
    apply();
    window.addEventListener(SUPPORT_DRAFT_EVENT, apply);
    return () => window.removeEventListener(SUPPORT_DRAFT_EVENT, apply);
  }, []);

  // ?topic=… is a live input, not just an initial value: a link into /contact
  // from a page the member is already on changes the param without remounting,
  // and the desk has to follow it.
  useEffect(() => {
    if (!topicParam) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTopic(topicParam);
  }, [topicParam]);

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
    const r = await sendContactMessage({ name, email, topic, message });
    if (r.ok) {
      setStatus("ok");
      setFeedback("Thanks — your message is on its way. We'll be in touch.");
      // Back to derived: a signed-in member sees their details again, a
      // signed-out one sees a blank form.
      setNameInput(null);
      setEmailInput(null);
      setMessage("");
      setTopic(contactTopics[0].value);
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
                className={`mt-3 ${inputClass} appearance-none bg-[length:16px] bg-[right_1rem_center] bg-no-repeat pr-10 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2364748b%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><polyline points=%226 9 12 15 18 9%22/></svg>')]`}
              >
                {contactTopics.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

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
