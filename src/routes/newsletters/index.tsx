import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { ArkPlusMark } from "../../components/ArkPlusMark";
import {
  formatPostDate,
  newsletter,
  type NewsletterPost,
} from "../../data/newsletters";
import { subscribeEmail } from "../../lib/beehiiv";
import {
  forgetNewsletterPosts,
  sourceFor,
} from "../../lib/newsletterSources";
import { useNewsletterSubscription } from "../../lib/useNewsletterSubscription";
import { useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/newsletters/")({
  component: NewslettersPage,
});

const breadcrumbs = (
  <Breadcrumbs items={[{ label: "Home", to: "/" }, { label: "Newsletters" }]} />
);

function NewslettersPage() {
  const { state } = useSubscriberAuth();
  const { isSubscribed, prefsLoading, isMember, isSubscriber } =
    useNewsletterSubscription();

  // Navigate instantly, then fetch client-side so there's no loader stall. The
  // server projects each issue for the reader's tier (the members' edition for
  // Ark+, the free edition otherwise), so wait for auth to settle and refetch
  // when the tier changes. A thrown fetch lands on "error" so the page can't
  // spin forever.
  const [load, setLoad] = useState<
    | { status: "loading" }
    | { status: "ok"; posts: NewsletterPost[] }
    | { status: "error" }
  >({ status: "loading" });

  const tierResolved = state.kind !== "loading";
  // The tier the last fetch ran under. The client cache holds one edition, so
  // a fetch under a different tier has to drop it first.
  const fetchedAsSubscriber = useRef<boolean | null>(null);

  useEffect(() => {
    if (!tierResolved) return;
    let alive = true;
    if (
      fetchedAsSubscriber.current !== null &&
      fetchedAsSubscriber.current !== isSubscriber
    ) {
      forgetNewsletterPosts();
    }
    fetchedAsSubscriber.current = isSubscriber;
    void sourceFor(newsletter.slug)
      .listPosts(newsletter.slug)
      .then(
        (posts) => {
          if (alive) setLoad({ status: "ok", posts });
        },
        () => {
          if (alive) setLoad({ status: "error" });
        },
      );
    return () => {
      alive = false;
    };
  }, [tierResolved, isSubscriber]);

  if (load.status === "error") {
    return (
      <PageShell breadcrumbs={breadcrumbs} title="Newsletters">
        <section>
          <div className="page-gutter py-10 sm:py-12">
            <p className="text-body-sm">
              We couldn&rsquo;t load the newsletter right now. Please refresh to
              try again.
            </p>
          </div>
        </section>
      </PageShell>
    );
  }

  if (load.status === "loading") {
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

  const { posts } = load;

  // The side column is whatever this reader is missing: guests get the email
  // form, signed-in readers who are off the list get a pointer to Settings
  // (which re-applies an Ark+ member's edition — the public form can't), and
  // anyone without Ark+ gets the members' edition pitch. Withheld while
  // Beehiiv prefs load so a card never flashes.
  const showSignup = !isMember;
  const showTurnOn = isMember && !prefsLoading && !isSubscribed;
  const showJoinPlus = !isSubscriber && !(isMember && prefsLoading);
  const showAside = showSignup || showTurnOn || showJoinPlus;

  return (
    <PageShell
      breadcrumbs={breadcrumbs}
      title={newsletter.title}
      lede={newsletter.description}
    >
      <section>
        <div className="page-gutter grid grid-cols-1 gap-8 py-10 sm:py-12 lg:grid-cols-12">
          {showAside ? (
            <div className="space-y-6 lg:col-span-5">
              {showSignup ? <SignupCard /> : null}
              {showTurnOn ? <TurnOnCard isSubscriber={isSubscriber} /> : null}
              {showJoinPlus ? <JoinPlusCard /> : null}
            </div>
          ) : null}
          <div className={showAside ? "lg:col-span-7" : "lg:col-span-12"}>
            <div className="label text-cyan">
              {isSubscriber
                ? "Recent issues · Members' edition"
                : "Recent issues"}
            </div>
            {posts.length === 0 ? (
              <p className="mt-8 text-body-sm">No recent issues yet.</p>
            ) : (
              <ul
                className={`mt-8 divide-y divide-rule border-y border-rule overflow-y-auto overscroll-y-contain ${
                  showAside
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
                          {p.tier === "ark-plus" && !isSubscriber
                            ? " · Ark+"
                            : ""}
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

/** A signed-in reader who isn't on the list. Settings is where they turn it on. */
function TurnOnCard({ isSubscriber }: { isSubscriber: boolean }) {
  return (
    <div className="border border-rule bg-navy-800/40 p-7">
      <div className="label text-cyan">Not in your inbox</div>
      <p className="mt-4 max-w-md text-body-sm text-fg">
        {isSubscriber
          ? "You're not getting the newsletter by email. Turn it on to get the members' edition every week."
          : "You're not getting the newsletter by email. Turn it on to get it every week."}
      </p>
      <Link
        to="/account/settings"
        className="button-text mt-6 inline-flex min-h-11 items-center gap-2 border border-cyan px-5 py-3 font-display font-bold text-cyan transition hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Email settings →
      </Link>
    </div>
  );
}

function JoinPlusCard() {
  return (
    <div className="border border-cyan/40 bg-navy-800/40 p-7">
      <div className="flex items-center gap-4">
        <ArkPlusMark className="h-12 w-12" />
        <div className="label text-cyan">Ark+</div>
      </div>
      <p className="mt-4 max-w-md text-body-sm text-fg">
        Ark+ members get the members&rsquo; edition of every issue — sharper
        analysis and source notes — plus ad-free episodes and the full archive.
      </p>
      <Link
        to="/plus"
        className="button-text mt-6 inline-flex min-h-11 items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Join Ark+ →
      </Link>
    </div>
  );
}

function SignupCard() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "ok" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    const r = await subscribeEmail(newsletter.slug, email.trim());
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
        {newsletter.cadence}. Written by {newsletter.authorName}. Free in your
        inbox.
      </p>
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
    </div>
  );
}
