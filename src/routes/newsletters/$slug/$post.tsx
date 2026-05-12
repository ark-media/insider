import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  formatPostDate,
  type NewsletterSlug,
} from "../../../data/newsletters";
import { getPost, getPublication, type FetchPostResult } from "../../../lib/beehiiv";
import { PageShell } from "../../../components/PageShell";
import { useSubscriberAuth } from "../../../lib/subscriberAuth";

export const Route = createFileRoute("/newsletters/$slug/$post")({
  loader: async ({ params }) => {
    const pub = await getPublication(params.slug as NewsletterSlug);
    if (!pub) throw notFound();
    return { pub };
  },
  component: PostPage,
});

function PostPage() {
  const { pub } = Route.useLoaderData();
  const { post: postSlug } = Route.useParams();
  const { state } = useSubscriberAuth();
  const isMember = state.kind === "member";
  const [result, setResult] = useState<FetchPostResult | "loading">("loading");

  useEffect(() => {
    let live = true;
    void getPost(pub.slug, postSlug, isMember).then(
      (r) => live && setResult(r),
    );
    return () => {
      live = false;
    };
  }, [pub.slug, postSlug, isMember]);

  if (result === "loading") {
    return (
      <PageShell title="Loading…" lede=" ">
        <></>
      </PageShell>
    );
  }

  if (result.kind === "not-found") {
    return (
      <PageShell
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

  const post = result.kind === "ok" ? result.post : result.preview;
  const gated = result.kind === "gated";

  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[820px] px-6 pt-12 pb-8 sm:px-10 sm:pt-20">
          <Link
            to="/newsletters/$slug"
            params={{ slug: pub.slug }}
            className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan transition hover:text-fg-strong"
          >
            ← {pub.shortTitle}
          </Link>
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
            {post.body.split("\n\n").map((para, i) => (
              <p key={i} className="break-words whitespace-pre-line">
                {para}
              </p>
            ))}
          </div>
        </div>
      </article>

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
