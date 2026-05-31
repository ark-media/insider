import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth0 } from "@auth0/auth0-react";
import { PageShell } from "../../components/PageShell";
import { NewsletterSignupForm } from "../../components/NewsletterSignupForm";
import {
  formatPostDate,
  type NewsletterPost,
  type NewsletterSlug,
} from "../../data/newsletters";
import { sourceFor } from "../../lib/newsletterSources";
import { useSubscriberAuth } from "../../lib/subscriberAuth";

export const Route = createFileRoute("/newsletters/")({
  loader: async () => {
    const entries = await Promise.all(
      cards.map(
        async (c) => [c.slug, await sourceFor(c.slug).listPosts(c.slug)] as const,
      ),
    );
    return {
      postsBySlug: Object.fromEntries(entries) as Record<
        NewsletterSlug,
        NewsletterPost[]
      >,
    };
  },
  component: NewslettersPage,
});

type NewsletterCard = {
  slug: NewsletterSlug;
  shortTitle: string;
  title: string;
  description: string;
  cadence: string;
  tier: "free" | "ark-plus";
};

const cards: NewsletterCard[] = [
  {
    slug: "ark-daily",
    shortTitle: "Ark Media",
    title: "The Ark Media Newsletter",
    description:
      "Our free dispatch — the through-lines from this week's interviews and what they tell us about the week ahead.",
    cadence: "Weekly",
    tier: "free",
  },
  {
    slug: "members-letter",
    shortTitle: "Members Letter",
    title: "The Ark+ Members Letter",
    description:
      "A members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading.",
    cadence: "Weekly",
    tier: "ark-plus",
  },
];

function NewslettersPage() {
  const { state } = useSubscriberAuth();
  const { postsBySlug } = Route.useLoaderData();
  const isMember = state.kind === "member";

  return (
    <PageShell
      eyebrow="Newsletters"
      title="Come aboard the Ark."
      lede="Subscribe to our newsletter and get new episodes every Friday."
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {cards.map((n) => {
              // Ark+ letter is members-only: free signups and guests both
              // resolve to a non-member state, so they get the join CTA in
              // place of the email form.
              const locked = n.tier === "ark-plus" && !isMember;
              return (
                <article
                  key={n.slug}
                  className="flex flex-col gap-6 border border-rule bg-navy-800/40 p-7"
                >
                  <div>
                    <div className="flex items-center justify-end text-[11px] font-semibold uppercase tracking-[0.22em]">
                      {n.tier === "ark-plus" ? (
                        <span className="border border-cyan/60 px-2 py-0.5 text-[10px] tracking-[0.18em] text-cyan">
                          Ark+
                        </span>
                      ) : (
                        <span className="text-fg-muted">Free</span>
                      )}
                    </div>
                    <h2 className="mt-4 font-display text-[22px] leading-[1.15] text-fg-strong">
                      {n.title}
                    </h2>
                    <p className="mt-3 text-[13.5px] leading-[1.6] text-fg-muted">
                      {n.description}
                    </p>
                    <p className="mt-4 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
                      {locked ? "Ark+ members only" : n.cadence}
                    </p>
                  </div>

                  {locked ? (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                      <SignInButton />
                      <JoinArkPlusCta />
                    </div>
                  ) : (
                    <NewsletterSignupForm slug={n.slug} />
                  )}

                  <RecentIssues slug={n.slug} posts={postsBySlug[n.slug]} />
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function SignInButton() {
  const { loginWithRedirect } = useAuth0();
  return (
    <button
      type="button"
      onClick={() => void loginWithRedirect()}
      className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 border border-rule-strong px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      Sign in
    </button>
  );
}

function JoinArkPlusCta() {
  return (
    <Link
      to="/plus"
      className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 bg-cyan px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      Join Ark+
      <span aria-hidden="true">→</span>
    </Link>
  );
}

function RecentIssues({
  slug,
  posts,
}: {
  slug: NewsletterSlug;
  posts: NewsletterPost[];
}) {
  if (posts.length === 0) return null;
  return (
    <div className="border-t border-rule pt-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Recent issues
      </div>
      <ul className="mt-4 divide-y divide-rule">
        {posts.slice(0, 3).map((p) => (
          <li key={p.slug}>
            <Link
              to="/newsletters/$slug/$post"
              params={{ slug, post: p.slug }}
              className="group flex flex-col gap-1 py-3 transition hover:text-cyan sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <span className="min-w-0 flex-1 break-words text-[14px] leading-snug text-fg-strong group-hover:text-cyan">
                {p.title}
              </span>
              <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-fg-muted group-hover:text-cyan">
                {formatPostDate(p.publishedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
