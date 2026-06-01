import type { SuggestedSpace } from "../../lib/circle";

/**
 * Shown when the feed is empty/quiet. Instead of a blank panel, nudge the
 * member to join a space — each suggestion deep-links into the app. Read-only:
 * joining happens in the app, not here.
 */
export function FeedEmptyState({
  spaces,
}: {
  spaces: SuggestedSpace[] | null;
}) {
  return (
    <div className="border border-rule bg-navy-800/40 p-8 sm:p-10">
      <h3 className="text-h3 leading-tight text-fg-strong">
        Your feed is quiet — join a space to fill it.
      </h3>
      <p className="mt-3 max-w-xl text-body-sm">
        Your feed comes alive once you've joined a few spaces. Here's where the
        community is most active right now.
      </p>

      {spaces === null ? (
        <p className="mt-6 text-body-sm text-fg-muted" role="status">
          Loading spaces…
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-rule border-y border-rule">
          {spaces.map((space) => (
            <li key={space.id} className="py-4">
              <a
                href={space.href}
                className="group grid grid-cols-1 items-center gap-2 sm:grid-cols-12 sm:gap-4"
              >
                <div className="sm:col-span-9">
                  <div className="button-text font-display font-bold text-fg-strong transition group-hover:text-cyan">
                    {space.name}
                  </div>
                  {space.description ? (
                    <p className="mt-1 text-body-sm">{space.description}</p>
                  ) : null}
                  {space.memberCount ? (
                    <p className="mt-1 meta">
                      {space.memberCount.toLocaleString()} members
                    </p>
                  ) : null}
                </div>
                <div className="sm:col-span-3 sm:text-right">
                  <span className="button-text font-display font-bold text-cyan">
                    Join in the app →
                  </span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
