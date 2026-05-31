import { useState } from "react";
import type { NewsletterSlug } from "../data/newsletters";
import { subscribeEmail } from "../lib/beehiiv";

/**
 * Inline email capture for a Beehiiv newsletter. Used on the newsletters hub
 * (one per card) and on the homepage's "Also from Ark Media" newsletter row.
 * Stretches to fill its container via `flex-1`, so the caller controls width.
 */
export function NewsletterSignupForm({ slug }: { slug: NewsletterSlug }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "ok" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    const r = await subscribeEmail(slug, email.trim());
    if (r.ok) {
      setStatus("ok");
      setMessage("You're on the list.");
      setEmail("");
    } else {
      setStatus("error");
      setMessage(r.error ?? "Could not subscribe.");
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-1 items-center">
      <label className="block flex-1">
        <span className="sr-only">Email</span>
        <div className="flex items-center border border-rule-strong bg-transparent transition focus-within:border-cyan">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="min-h-11 w-full bg-transparent px-3 py-2 text-[13px] text-fg-strong outline-none placeholder:text-fg-muted"
          />
          <button
            type="submit"
            disabled={status === "submitting"}
            className="min-h-11 border-l border-rule-strong bg-cyan px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
          >
            {status === "ok" ? "Subscribed" : "Subscribe"}
          </button>
        </div>
        {message ? (
          <p
            className={`mt-2 text-[11px] ${
              status === "error" ? "text-danger" : "text-cyan"
            }`}
            aria-live="polite"
          >
            {message}
          </p>
        ) : null}
      </label>
    </form>
  );
}
