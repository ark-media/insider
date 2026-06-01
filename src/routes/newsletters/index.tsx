import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import {
  formatPostDate,
  newsletterSlugForReader,
  type Newsletter,
  type NewsletterPost,
} from "../../data/newsletters";
import { getPublication, subscribeEmail } from "../../lib/beehiiv";
import { sourceFor } from "../../lib/newsletterSources";
import { useNewsletterSubscription } from "../../lib/useNewsletterSubscription";
import { useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/newsletters/")({
  component: NewslettersPage,
});

const breadcrumbs = (
  <Breadcrumbs
    items={[
      { label: "Home", to: "/" },
      { label: "Newsletters" },
    ]}
  />
);

function NewslettersPage() {
  const { state } = useSubscriberAuth();
  const {
    isSubscribed,
    prefsLoading,
    isMember,
    isSubscriber,
  } = useNewsletterSubscription();

  // Navigate instantly, then fetch client-side so there's no loader stall.
  // Which newsletter to show is derived from the auth tier, so we wait for auth
  // to settle before fetching — members land directly on the Ark+ slug instead
  // of fetching the free one and refetching. The data is null until it arrives,
  // which drives the loading state below.
  const [data, setData] = useState<
    { pub: Newsletter; posts: NewsletterPost[] } | null
  >(null);

  const tierResolved = state.kind !== "loading";
  const wantsMembersLetter =
    state.kind === "member" && state.me.tier === "ark-plus-member";

  useEffect(() => {
    if (!tierResolved) return;
    let alive = true;
    const slug = newsletterSlugForReader(wantsMembersLetter);
    void (async () => {
      const pub = await getPublication(slug);
      if (!pub || !alive) return;
      const posts = await sourceFor(slug).listPosts(slug);
      if (alive) setData({ pub, posts });
    })();
    return () => {
      alive = false;
    };
  }, [tierResolved, wantsMembersLetter]);

  if (!data) {
    return (
      <PageShell breadcrumbs={breadcrumbs} title="Newsletters">
        <section>
          <div className="page-gutter py-10 sm:py-12">
            <p className="text-body-sm">Loading…</p>
          </div>
        </section>
      </PageShell>
    );
  }

  const { pub, posts } = data;

  // Guests see signup. Ark-daily: hide the email form when Beehiiv says you're
  // on the list. Members letter: hide the Ark+ CTA for subscribers (JWT tier).
  // While Beehiiv prefs load we withhold the card so the form never flashes.
  const showSignup =
    !isMember ||
    (prefsLoading
      ? false
      : pub.slug === "members-letter"
        ? !isSubscriber
        : !isSubscribed);

  return (
    <PageShell
      breadcrumbs={breadcrumbs}
      title={pub.title}
      lede={pub.description}
    >
      <section>
        <div className="page-gutter grid grid-cols-1 gap-8 py-10 sm:py-12 lg:grid-cols-12">
          {showSignup ? (
            <div className="lg:col-span-5">
              <SignupCard pub={pub} />
              {pub.slug !== "members-letter" && !isSubscriber ? (
                <JoinPlusCard />
              ) : null}
            </div>
          ) : null}
          <div className={showSignup ? "lg:col-span-7" : "lg:col-span-12"}>
            <div className="label text-cyan">Recent issues</div>
            {posts.length === 0 ? (
              <p className="mt-8 text-body-sm">No recent issues yet.</p>
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
                        <span className="min-w-0 flex-1 break-words text-h3 group-hover:text-cyan">
                          {p.title}
                        </span>
                        <span className="meta shrink-0 group-hover:text-cyan">
                          {formatPostDate(p.publishedAt)}
                          {p.tier === "ark-plus" ? " · Ark+" : ""}
                        </span>
                      </div>
                      <p className="mt-2 max-w-2xl text-body-sm">{p.excerpt}</p>
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

function JoinPlusCard() {
  return (
    <div className="mt-6 border border-cyan/40 bg-navy-800/40 p-7">
      <div className="label text-cyan">Ark+</div>
      <p className="mt-4 max-w-md text-body-sm text-fg">
        Get the members-only newsletter, ad-free episodes, and the full
        archive when you join Ark+.
      </p>
      <Link
        to="/plus"
        className="button-text mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan"
      >
        Join Ark+ →
      </Link>
    </div>
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
      <div className="label text-cyan">Subscribe</div>
      <p className="mt-4 max-w-md text-body-sm text-fg">
        {pub.cadence}. Written by {pub.authorName}.
        {pub.tier === "ark-plus"
          ? " Members-only — included with Ark+."
          : " Free in your inbox."}
      </p>
      {pub.tier === "ark-plus" ? (
        <Link
          to="/plus"
          className="button-text mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan"
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
                className="min-h-11 w-full bg-transparent px-3 py-2.5 text-body text-fg-strong outline-none placeholder:text-fg-muted"
              />
              <button
                type="submit"
                disabled={status === "submitting"}
                className="button-text flex shrink-0 items-center justify-center self-stretch border-l border-rule-strong bg-cyan pl-5 pr-[calc(1.25rem+0.18em)] text-navy transition hover:bg-fg-strong hover:text-navy-900 disabled:opacity-60"
              >
                {status === "ok" ? "Subscribed" : "Subscribe"}
              </button>
            </div>
          </label>
          {message ? (
            <p
              className={`mt-3 text-body-sm ${
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
