import {
  type ActivityDigest,
  type CommunityFeedItem,
  type SuggestedSpace,
} from "../../lib/circle";
import { FeedEmptyState } from "./FeedEmptyState";

function formatPostDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

/**
 * The subscriber's community feed: read-only teasers of curated highlights.
 * Every card deep-links into the app — there's no like/reply/post UI on
 * the web. `items === null` is loading; an empty list renders the onboarding
 * nudge instead of a blank panel.
 */
export function CommunityFeed({
  items,
  digest,
  spaces,
}: {
  items: CommunityFeedItem[] | null;
  digest: ActivityDigest | null;
  spaces: SuggestedSpace[] | null;
}) {
  if (items === null) {
    return (
      <p className="text-body-sm text-fg-muted" role="status">
        Loading your feed…
      </p>
    );
  }

  if (items.length === 0) {
    return <FeedEmptyState spaces={spaces} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* v1: digest is always null and this stays hidden. v2 fills it in. */}
      {digest ? <ActivityDigestBanner digest={digest} /> : null}

      <ul className="divide-y divide-rule border-y border-rule">
        {items.map((item) => (
          <li key={item.id} className="py-6">
            <FeedCard item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeedCard({ item }: { item: CommunityFeedItem }) {
  return (
    <a
      href={item.href}
      className="group block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="button-text font-display font-bold text-fg-strong transition group-hover:text-cyan">
          {item.title ?? item.authorName}
        </div>
        <div className="meta shrink-0">{formatPostDate(item.publishedAt)}</div>
      </div>
      <p className="mt-1 meta">
        {item.title ? `${item.authorName} · ${item.authorRole}` : item.authorRole}
      </p>
      <p className="mt-3 max-w-2xl text-body-sm">{item.excerpt}</p>
      <p className="mt-3 button-text font-display font-bold text-cyan transition group-hover:underline">
        Read &amp; reply in the app →
      </p>
    </a>
  );
}

function ActivityDigestBanner({ digest }: { digest: ActivityDigest }) {
  return (
    <div className="border border-cyan/40 bg-cyan/[0.06] p-5">
      <p className="label text-cyan">Since you were last here</p>
      <p className="mt-2 text-body-sm text-fg-strong">
        {digest.newPosts} new posts · {digest.replies} replies ·{" "}
        {digest.mentions} mentions
      </p>
    </div>
  );
}
