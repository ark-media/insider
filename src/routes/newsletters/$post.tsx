import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { formatPostDate, newsletter } from "../../data/newsletters";
import { calendarDateParts } from "../../../shared/format-date";
import {
  forgetNewsletterPosts,
  sourceFor,
} from "../../lib/newsletterSources";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { ContentError } from "../../components/ContentError";
import { ArkPlusMark } from "../../components/ArkPlusMark";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";
import { NewsletterArticle } from "../../lib/newsletter-renderer";
import { fetchPostDocument } from "../../lib/beehiiv";
import {
  NewsletterFrame,
  NEWSLETTER_PAPER,
} from "../../components/NewsletterFrame";

export const Route = createFileRoute("/newsletters/$post")({
  beforeLoad: ({ params }) => {
    // The newsletter's own slug is not a post; send it to the listing.
    if (params.post === newsletter.slug) {
      throw redirect({ to: "/newsletters", replace: true });
    }
  },
  // The session cookie rides the request, so the server already answers with
  // the edition this reader is entitled to — no tier lookup needed here.
  // The issue's own Beehiiv HTML rides a separate request (it's ~70 KB, too
  // heavy for the list); both are the edition the cookie is entitled to.
  loader: async ({ params }) => {
    const [posts, documentHtml] = await Promise.all([
      sourceFor(newsletter.slug).listPosts(newsletter.slug),
      fetchPostDocument(newsletter.slug, params.post),
    ]);
    return { posts, documentHtml };
  },
  component: PostPage,
  // The issue list throws when /api/beehiiv/posts fails; say so in the page
  // rather than the router's bare default error screen.
  errorComponent: PostError,
});

function PostError() {
  const router = useRouter();
  return (
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Newsletters", to: "/newsletters" },
          ]}
        />
      }
      title="Newsletters"
    >
      <section>
        <div className="page-gutter py-10 sm:py-12">
          <ContentError
            message="We couldn't load this issue right now."
            onRetry={() => void router.invalidate()}
          />
        </div>
      </section>
    </PageShell>
  );
}

function PostPage() {
  const router = useRouter();
  const { posts, documentHtml } = Route.useLoaderData();
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

  const post = posts.find((p) => p.slug === postSlug);

  if (!post) {
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

  const gated = post.tier === "ark-plus" && !isArkPlusSubscriber;

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

  // A members-only issue's free edition is just its header, so a non-member
  // gets the paywall below, not a header on its own.
  const framed = documentHtml !== null && !(gated && post.membersOnly);

  const breadcrumbs = (
    <Breadcrumbs
      items={[
        { label: "Home", to: "/" },
        { label: "Newsletters", to: "/newsletters" },
        { label: post.title },
      ]}
    />
  );

  return (
    <main className="relative">
      {framed ? (
        <>
          {/* The issue's masthead leads, so the page adds one quiet strip:
              a way back, then byline and date. Sized to the issue's column
              (672px, 40px gutters) so it lines up with the masthead. */}
          <section className="section-hero relative">
            <div className="mx-auto flex max-w-[672px] flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-10 py-6 sm:py-7">
              {breadcrumbs}
              <h1 className="sr-only">{post.title}</h1>
              <p className="meta">
                {post.authorName}
                <span className="mx-2 text-fg-faint">·</span>
                <time dateTime={post.publishedAt}>
                  {formatPostDate(post.publishedAt)}
                </time>
              </p>
            </div>
          </section>
          {/* Full-bleed in the issue's own paper colour: one seam where the
              site ends and the newsletter begins, not a box inside a band. */}
          <article
            className="section-hero border-t border-rule"
            style={{ backgroundColor: NEWSLETTER_PAPER }}
          >
            <NewsletterFrame html={documentHtml} title={post.title} />
          </article>
        </>
      ) : (
        <>
          <section className="section-hero relative">
            <div className="mx-auto max-w-[1040px] px-6 pt-10 pb-4 sm:px-10 sm:pt-14">
              {breadcrumbs}
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
                    {newsletter.shortTitle} · Newsletter
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
            </header>
          </section>

          <article>
            <div className="mx-auto max-w-[1040px] px-6 pb-16 sm:px-10">
              {post.bodyHtml ? (
                <NewsletterArticle
                  html={post.bodyHtml}
                  postTitle={post.title}
                />
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
        </>
      )}

      {/* Only posts with their own Fold thread get a discuss link. The
          generic per-newsletter "Comment in the app" fallback is hidden until
          that Circle link is set up. */}
      {!gated && post.discussUrl ? (
        <section>
          <div className="mx-auto flex max-w-[1040px] flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-10">
            <div>
              <div className="label text-cyan">Discuss this piece</div>
              <p className="mt-2 text-body-sm text-fg">
                There&rsquo;s an open thread on this post in the Fold.
              </p>
            </div>
            <a
              href={post.discussUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex shrink-0 items-center justify-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Discuss on forum →
            </a>
          </div>
        </section>
      ) : null}

      {gated ? (
        <section className="border-t border-cyan/30">
          <div className="mx-auto max-w-[1040px] px-6 py-16 sm:px-10">
            <div className="flex items-center gap-4">
              <ArkPlusMark className="h-14 w-14" alt="Ark+" />
              <div className="label text-cyan">Members only</div>
            </div>
            <h2 className="mt-6 font-display text-[28px] leading-[1.1] text-fg-strong">
              The rest of this issue is in the members&rsquo; edition.
            </h2>
            <p className="mt-4 max-w-2xl text-body-lg">
              Ark+ members get the full issue in their inbox every week, along
              with the private, ad-free feed.
            </p>
            <Link
              to="/subscribe"
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
