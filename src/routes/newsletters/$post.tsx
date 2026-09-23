import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { formatPostDate, newsletter } from "../../data/newsletters";
import { calendarDateParts } from "../../../shared/format-date";
import {
  forgetNewsletterPosts,
  sourceFor,
} from "../../lib/newsletterSources";
import { newsletterCommentUrl } from "../../lib/circle";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { ArkPlusMark } from "../../components/ArkPlusMark";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";
import { NewsletterArticle } from "../../lib/newsletter-renderer";

export const Route = createFileRoute("/newsletters/$post")({
  beforeLoad: ({ params }) => {
    // The newsletter's own slug is not a post; send it to the listing.
    if (params.post === newsletter.slug) {
      throw redirect({ to: "/newsletters", replace: true });
    }
  },
  // The session cookie rides the request, so the server already answers with
  // the edition this reader is entitled to — no tier lookup needed here.
  loader: async () => {
    const posts = await sourceFor(newsletter.slug).listPosts(newsletter.slug);
    return { posts };
  },
  component: PostPage,
});

function PostPage() {
  const router = useRouter();
  const { posts } = Route.useLoaderData();
  const { post: postSlug } = Route.useParams();
  const { state } = useSubscriberAuth();
  const isArkPlusSubscriber = isArkPlusMember(state);

  // The loader's list came back as whatever edition the cookie was entitled
  // to, so the first resolved tier is just recorded. A later flip (sign-in,
  // checkout) means the cached list is the wrong edition: drop it and reload.
  const resolvedTier = useRef<boolean | null>(null);
  useEffect(() => {
    if (state.kind === "loading") return;
    const previous = resolvedTier.current;
    resolvedTier.current = isArkPlusSubscriber;
    if (previous === null || previous === isArkPlusSubscriber) return;
    forgetNewsletterPosts();
    void router.invalidate();
  }, [state.kind, isArkPlusSubscriber, router]);

  const found = posts.find((p) => p.slug === postSlug);

  if (!found) {
    return (
      <PageShell
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Newsletters", to: "/newsletters" },
              { label: "Not found" },
            ]}
          />
        }
        title="Post not found."
        lede="We couldn't find that post."
      >
        <section>
          <div className="page-section">
            <Link
              to="/newsletters"
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              ← Back to {newsletter.title}
            </Link>
          </div>
        </section>
      </PageShell>
    );
  }

  const gated = found.tier === "ark-plus" && !isArkPlusSubscriber;
  const post = found;

  // `publishedAt` is a calendar date ('YYYY-MM-DD'). Read its components
  // directly instead of going through Date, whose local-time getters dated the
  // stamp a day early for every reader west of UTC.
  const issueDate = calendarDateParts(post.publishedAt);
  const issueMonthDay = issueDate
    ? `${String(issueDate.month).padStart(2, "0")}.${String(
        issueDate.day,
      ).padStart(2, "0")}`
    : null;
  const issueYear = issueDate ? String(issueDate.year) : null;

  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="mx-auto max-w-[1040px] px-6 pt-10 pb-4 sm:px-10 sm:pt-14">
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Newsletters", to: "/newsletters" },
              { label: post.title },
            ]}
          />
        </div>
        <header className="mx-auto max-w-[1040px] px-6 pb-12 pt-6 sm:px-10 sm:pb-16">
          <div className="grid grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-[auto_1fr] sm:items-end">
            {issueMonthDay && issueYear ? (
              <div className="rise rise-1 flex flex-col leading-none">
                <span className="label font-display font-bold tracking-[0.28em] text-cyan">
                  Issue
                </span>
                <span className="mt-3 font-display text-[clamp(3.4rem,7vw,5.2rem)] font-black italic leading-[0.85] tracking-[-0.02em] text-fg-strong">
                  {issueMonthDay}
                </span>
                <span className="mt-1 font-display text-[clamp(1rem,1.6vw,1.25rem)] font-semibold uppercase tracking-[0.3em] text-fg-muted">
                  {issueYear}
                </span>
              </div>
            ) : null}
            <div className="rise rise-2">
              <div className="label tracking-[0.28em] text-cyan">
                {newsletter.shortTitle}
                {post.tier === "ark-plus" ? " · Ark+" : " · Newsletter"}
              </div>
              <h1 className="mt-4 font-display text-[clamp(2rem,4.5vw,3.4rem)] font-bold leading-[1.05] tracking-[-0.01em] text-fg-strong">
                {post.title}
              </h1>
              <p className="mt-5 meta tracking-[0.22em]">
                <span className="text-fg-strong">{post.authorName}</span>
                <span className="mx-2 text-fg-faint">·</span>
                {formatPostDate(post.publishedAt)}
              </p>
            </div>
          </div>
          <div className="mt-10 h-px w-full bg-gradient-to-r from-cyan/60 via-rule to-transparent" />
        </header>
      </section>

      <article>
        <div className="mx-auto max-w-[1040px] px-6 pb-16 sm:px-10">
          {post.bodyHtml ? (
            <NewsletterArticle html={post.bodyHtml} postTitle={post.title} />
          ) : (
            <div className="space-y-5 text-body leading-[1.75]">
              {post.body.split("\n\n").map((para, i) => (
                <p
                  key={`${i}-${para.slice(0, 32)}`}
                  className="break-words whitespace-pre-line"
                >
                  {para}
                </p>
              ))}
            </div>
          )}
        </div>
      </article>

      {gated ? null : (
        <section>
          <div className="mx-auto flex max-w-[1040px] flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-10">
            <div>
              <div className="label text-cyan">
                {post.discussUrl ? "Discuss this piece" : "Keep the conversation going"}
              </div>
              <p className="mt-2 text-body-sm text-fg">
                {post.discussUrl
                  ? "There's an open thread on this post in the Fold."
                  : "Comments and replies live in the Fold. Sign in once and they open straight to the thread."}
              </p>
            </div>
            <a
              href={post.discussUrl ?? newsletterCommentUrl(newsletter.slug)}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex shrink-0 items-center justify-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              {post.discussUrl ? "Discuss on forum →" : "Comment in the app →"}
            </a>
          </div>
        </section>
      )}

      {gated ? (
        <section className="border-t border-cyan/30">
          <div className="mx-auto max-w-[1040px] px-6 py-16 sm:px-10">
            <div className="flex items-center gap-4">
              <ArkPlusMark className="h-14 w-14" alt="Ark+" />
              <div className="label text-cyan">
                Members only
              </div>
            </div>
            <h2 className="mt-6 font-display text-[28px] leading-[1.1] text-fg-strong">
              The rest of this issue is in the members&rsquo; edition.
            </h2>
            <p className="mt-4 max-w-2xl text-body-lg">
              Ark+ members get the full issue in their inbox every week, along
              with the private, ad-free feed.
            </p>
            <Link
              to="/plus"
              className="mt-8 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Subscribe →
            </Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}
