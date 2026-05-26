import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import {
  formatPostDate,
  type NewsletterSlug,
} from "../../../data/newsletters";
import { getPublication } from "../../../lib/beehiiv";
import {
  buildGatedPreview,
  sourceFor,
} from "../../../lib/newsletterSources";
import { newsletterCommentUrl } from "../../../lib/circle";
import { PageShell } from "../../../components/PageShell";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { useSubscriberAuth } from "../../../lib/subscriberAuth";
import { renderShowNotes } from "../../../lib/show-notes-renderer";

export const Route = createFileRoute("/newsletters/$slug/$post")({
  loader: async ({ params }) => {
    const slug = params.slug as NewsletterSlug;
    const pub = await getPublication(slug);
    if (!pub) throw notFound();
    // Fetch the unfiltered list here; we apply the membership-aware gate at
    // render time so navigating list → post doesn't refetch, and so the
    // member/non-member gate updates without a new request.
    const posts = await sourceFor(slug).listPosts(slug);
    return { pub, posts };
  },
  component: PostPage,
});

function PostPage() {
  const { pub, posts } = Route.useLoaderData();
  const { post: postSlug } = Route.useParams();
  const { state } = useSubscriberAuth();
  const isMember = state.kind === "member";

  const found = posts.find((p) => p.slug === postSlug);

  if (!found) {
    return (
      <PageShell
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Newsletters", to: "/newsletters" },
              {
                label: pub.shortTitle,
                to: "/newsletters/$slug",
                params: { slug: pub.slug },
              },
              { label: "Not found" },
            ]}
          />
        }
        eyebrow={pub.shortTitle}
        title="Post not found."
        lede="We couldn't find that post."
      >
        <section className="border-t border-rule bg-navy-900">
          <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
            <Link
              to="/newsletters/$slug"
              params={{ slug: pub.slug }}
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
            >
              ← Back to {pub.title}
            </Link>
          </div>
        </section>
      </PageShell>
    );
  }

  const gated = found.tier === "ark-plus" && !isMember;
  const post = gated ? buildGatedPreview(found) : found;

  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[820px] px-6 pt-12 pb-8 sm:px-10 sm:pt-20">
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Newsletters", to: "/newsletters" },
              {
                label: pub.shortTitle,
                to: "/newsletters/$slug",
                params: { slug: pub.slug },
              },
              { label: post.title },
            ]}
          />
          <h1 className="mt-8 font-display text-[clamp(1.8rem,4vw,3rem)] leading-[1.1] text-fg-strong">
            {post.title}
          </h1>
          <p className="mt-4 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
            {formatPostDate(post.publishedAt)} · {post.authorName}
            {post.tier === "ark-plus" ? " · Ark+" : ""}
          </p>
        </div>
      </section>

      <article className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[820px] px-6 py-12 sm:px-10">
          <div className="space-y-5 text-[16px] leading-[1.75] text-fg">
            {post.bodyHtml ? (
              renderShowNotes(post.bodyHtml)
            ) : (
              post.body.split("\n\n").map((para, i) => (
                <p key={`${i}-${para.slice(0, 32)}`} className="break-words whitespace-pre-line">
                  {para}
                </p>
              ))
            )}
          </div>
        </div>
      </article>

      {gated ? null : (
        <section className="border-t border-rule bg-navy-800/40">
          <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-10">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                {post.discussUrl ? "Discuss this piece" : "Keep the conversation going"}
              </div>
              <p className="mt-2 text-[14px] leading-[1.6] text-fg">
                {post.discussUrl
                  ? "There's an open thread on this post in the Ark+ community."
                  : "Comments and replies live in the Circle community. Sign in once and they open straight to the thread."}
              </p>
            </div>
            <a
              href={
                post.discussUrl
                  ? `/circle-sso?return_to=${encodeURIComponent(post.discussUrl)}`
                  : newsletterCommentUrl(pub.slug)
              }
              className="inline-flex shrink-0 items-center justify-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              {post.discussUrl ? "Discuss on forum →" : "Comment in Circle →"}
            </a>
          </div>
        </section>
      )}

      {gated ? (
        <section className="border-t border-cyan/30 bg-navy-800/40">
          <div className="mx-auto max-w-[820px] px-6 py-16 sm:px-10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Members only
            </div>
            <h2 className="mt-6 font-display text-[28px] leading-[1.1] text-fg-strong">
              The rest of this post is for Ark+ members.
            </h2>
            <p className="mt-4 max-w-2xl text-[14.5px] leading-[1.7] text-fg">
              Ark+ membership is one bill, one login. It includes the paid
              feed, members-only newsletters, and the community.
            </p>
            <Link
              to="/plus"
              className="mt-8 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
            >
              Become an Ark+ member →
            </Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}
