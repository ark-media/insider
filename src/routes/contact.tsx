import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell } from "../components/PageShell";
import { contactTopics, type ContactTopic } from "../config/urls";
import { sendContactMessage } from "../lib/contact";

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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState<ContactTopic>(
    topicParam ?? contactTopics[0].value,
  );
  const [message, setMessage] = useState("");
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
      setName("");
      setEmail("");
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
                  onChange={(e) => setName(e.target.value)}
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
                  onChange={(e) => setEmail(e.target.value)}
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
