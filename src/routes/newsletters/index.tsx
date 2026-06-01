import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import {
  formatPostDate,
  newsletterSlugForReader,
  type Newsletter,
} from "../../data/newsletters";
import { fetchMe } from "../../lib/auth";
import { getPublication, subscribeEmail } from "../../lib/beehiiv";
import { sourceFor } from "../../lib/newsletterSources";
import { useNewsletterSubscription } from "../../lib/useNewsletterSubscription";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { getToken } from "../../lib/tokenStore";

export const Route = createFileRoute("/newsletters/")({
  loader: async () => {
    const token = await getToken();
    const me = token ? await fetchMe({ accessToken: token }) : null;
    const slug = newsletterSlugForReader(me?.tier === "subscriber");
    const pub = await getPublication(slug);
    if (!pub) throw notFound();
    const posts = await sourceFor(slug).listPosts(slug);
    return { pub, posts };
  },
  component: NewslettersPage,
});

function NewslettersPage() {
  const router = useRouter();
  const { pub, posts } = Route.useLoaderData();
  const { state } = useSubscriberAuth();
  const { isSubscribed, prefsLoading, isMember } = useNewsletterSubscription();

  // First loader pass may run before Auth0 token is ready; reload for Ark+ slug.
  useEffect(() => {
    if (state.kind !== "member" || state.me.tier !== "subscriber") return;
    if (pub.slug === "members-letter") return;
    void router.invalidate();
  }, [state, router, pub.slug]);

  // Guests see signup; signed-in Ark+ members and free-list subscribers see
  // recent issues only. While prefs load for free-tier members we withhold
  // the card so subscribed readers never get a flash of the form.
  const showSignup = !isMember || (!prefsLoading && !isSubscribed);

  return (
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Newsletters" },
          ]}
        />
      }
      eyebrow={pub.tier === "ark-plus" ? "Ark+ newsletter" : "Newsletter"}
      title={pub.title}
      lede={pub.description}
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-12 px-6 py-16 sm:px-10 lg:grid-cols-12">
          {showSignup ? (
            <div className="lg:col-span-5">
              <SignupCard pub={pub} />
            </div>
          ) : null}
          <div className={showSignup ? "lg:col-span-7" : "lg:col-span-12"}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Recent issues
            </div>
            {posts.length === 0 ? (
              <p className="mt-8 text-[14px] text-fg-muted">
                No recent issues yet.
              </p>
            ) : (
              <ul
                className={`mt-8 divide-y divide-rule border-y border-rule overflow-y-auto overscroll-y-contain ${
                  showSignup
                    ? "max-h-[min(28rem,55vh)] lg:max-h-[22rem]"
                    : "max-h-[min(36rem,65vh)]"
                }`}
              >
                {posts.map((p) => (
                  <li key={p.slug}>
                    <Link
                      to="/newsletters/$post"
                      params={{ post: p.slug }}
                      className="group block py-5 transition hover:text-cyan"
                    >
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                        <span className="min-w-0 flex-1 break-words font-display text-[18px] tracking-[-0.005em] text-fg-strong group-hover:text-cyan">
                          {p.title}
                        </span>
                        <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-fg-muted group-hover:text-cyan">
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
            <div className="flex border border-rule-strong bg-transparent transition focus-within:border-cyan">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="min-h-11 w-full bg-transparent px-3 py-2.5 text-[14px] text-fg-strong outline-none placeholder:text-fg-muted"
              />
              <button
                type="submit"
                disabled={status === "submitting"}
                className="flex shrink-0 items-center justify-center self-stretch border-l border-rule-strong bg-cyan pl-5 pr-[calc(1.25rem+0.18em)] text-[12px] font-semibold uppercase leading-none tracking-[0.18em] text-navy transition hover:bg-fg-strong hover:text-navy-900 disabled:opacity-60"
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
