import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  formatPostDate,
  type Newsletter,
  type NewsletterPost,
  type NewsletterSlug,
} from "../../../data/newsletters";
import {
  getPublication,
  listPosts,
  subscribeEmail,
} from "../../../lib/beehiiv";
import { PageShell } from "../../../components/PageShell";

export const Route = createFileRoute("/newsletters/$slug/")({
  loader: async ({ params }) => {
    const pub = await getPublication(params.slug as NewsletterSlug);
    if (!pub) throw notFound();
    return { pub };
  },
  component: NewsletterLandingPage,
});

function NewsletterLandingPage() {
  const { pub } = Route.useLoaderData();
  const [posts, setPosts] = useState<NewsletterPost[] | null>(null);

  useEffect(() => {
    let live = true;
    void listPosts(pub.slug).then((p) => live && setPosts(p));
    return () => {
      live = false;
    };
  }, [pub.slug]);

  return (
    <PageShell
      eyebrow={pub.tier === "ark-plus" ? "Ark+ newsletter" : "Newsletter"}
      title={pub.title}
      lede={pub.description}
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-12 px-6 py-16 sm:px-10 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <SignupCard pub={pub} />
          </div>
          <div className="lg:col-span-7">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Recent issues
            </div>
            {posts === null ? (
              <p className="mt-8 text-[14px] text-fg-muted">Loading…</p>
            ) : (
              <ul className="mt-8 divide-y divide-rule border-y border-rule">
                {posts.map((p) => (
                  <li key={p.slug}>
                    <Link
                      to="/newsletters/$slug/$post"
                      params={{ slug: pub.slug, post: p.slug }}
                      className="group block py-5 transition hover:text-cyan"
                    >
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                        <span className="font-display text-[18px] tracking-[-0.005em] text-fg-strong group-hover:text-cyan">
                          {p.title}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.18em] text-fg-muted group-hover:text-cyan">
                          {formatPostDate(p.publishedAt)}
                          {p.tier === "ark-plus" ? " · Ark+" : ""}
                        </span>
                      </div>
                      <p className="mt-2 max-w-2xl text-[13.5px] leading-[1.6] text-fg-muted">
                        {p.excerpt}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function SignupCard({ pub }: { pub: Newsletter }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "ok" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    const r = await subscribeEmail(pub.slug, email.trim());
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
    <div className="border border-rule bg-navy-800/40 p-7">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Subscribe
      </div>
      <p className="mt-4 max-w-md text-[14px] leading-[1.6] text-fg">
        {pub.cadence}. Written by {pub.authorName}.
        {pub.tier === "ark-plus"
          ? " Members-only — included with Ark+."
          : " Free in your inbox."}
      </p>
      {pub.tier === "ark-plus" ? (
        <Link
          to="/plus"
          className="mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
        >
          Become an Ark+ member →
        </Link>
      ) : (
        <form onSubmit={onSubmit} className="mt-6">
          <label className="block">
            <span className="sr-only">Email</span>
            <div className="flex items-center border border-rule-strong bg-transparent transition focus-within:border-cyan">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-transparent px-3 py-2.5 text-[14px] text-fg-strong outline-none placeholder:text-fg-muted"
              />
              <button
                type="submit"
                disabled={status === "submitting"}
                className="border-l border-rule-strong bg-cyan px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-navy transition hover:bg-fg-strong disabled:opacity-60"
              >
                {status === "ok" ? "Subscribed" : "Subscribe"}
              </button>
            </div>
          </label>
          {message ? (
            <p
              className={`mt-3 text-[12px] ${
                status === "error" ? "text-danger" : "text-cyan"
              }`}
              aria-live="polite"
            >
              {message}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
