import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell } from "../../components/PageShell";
import { newsletters } from "../../data/newsletters";
import { subscribeEmail } from "../../lib/beehiiv";

export const Route = createFileRoute("/newsletters/")({
  component: NewslettersPage,
});

function NewslettersPage() {
  return (
    <PageShell
      eyebrow="Newsletters"
      title="In your inbox, every week."
      lede="Free in your inbox. Members-only editions in your inbox and on the web. Pick what you want."
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {newsletters.map((n) => (
              <article
                key={n.slug}
                className="flex flex-col justify-between gap-6 border border-rule bg-navy-800/40 p-7"
              >
                <div>
                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.22em]">
                    <span className="text-cyan">{n.shortTitle}</span>
                    {n.tier === "ark-plus" ? (
                      <span className="border border-cyan/60 px-2 py-0.5 text-[10px] tracking-[0.18em] text-cyan">
                        Ark+
                      </span>
                    ) : (
                      <span className="text-fg-muted">Free</span>
                    )}
                  </div>
                  <h3 className="mt-4 font-display text-[22px] leading-[1.15] text-fg-strong">
                    {n.title}
                  </h3>
                  <p className="mt-3 text-[13.5px] leading-[1.6] text-fg-muted">
                    {n.description}
                  </p>
                  <p className="mt-4 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
                    {n.cadence}
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                  <Link
                    to="/newsletters/$slug"
                    params={{ slug: n.slug }}
                    className="inline-flex items-center gap-2 border border-rule-strong px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-fg-strong transition hover:border-cyan hover:text-cyan"
                  >
                    Recent issues →
                  </Link>
                  <SignupForm slug={n.slug} />
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function SignupForm({
  slug,
}: {
  slug: (typeof newsletters)[number]["slug"];
}) {
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
            className="w-full bg-transparent px-3 py-2 text-[13px] text-fg-strong outline-none placeholder:text-fg-muted"
          />
          <button
            type="submit"
            disabled={status === "submitting"}
            className="border-l border-rule-strong bg-cyan px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-navy transition hover:bg-fg-strong disabled:opacity-60"
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
