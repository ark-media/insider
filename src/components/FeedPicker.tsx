import { Breadcrumbs } from "./Breadcrumbs";
import type { UserFeed } from "../lib/auth";

// The landing step when a member has more than one private feed: a grid of
// cover-art tiles. Picking one drops into that show's setup flow.
export function FeedPicker({
  feeds,
  onSelect,
}: {
  feeds: UserFeed[];
  onSelect: (feedId: number) => void;
}) {
  return (
    <main className="relative text-fg-strong">
      <div className="mx-auto max-w-[1040px] px-6 pb-24 pt-8 sm:px-10 sm:pb-28">
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Account", to: "/account" },
            { label: "Podcast feed" },
          ]}
          className="mb-10"
        />

        <div className="rise rise-1">
          <div className="label flex items-center gap-3 text-cyan">
            <span className="h-px w-10 bg-cyan" />
            Your private feeds
          </div>
          <h1 className="mt-5 text-fg-strong">
            <span className="display-upright block text-[clamp(1.9rem,4.2vw,3.4rem)]">
              Pick a show to
            </span>
            <span className="display-upright block text-[clamp(1.9rem,4.2vw,3.4rem)]">
              <span className="display text-cyan">set up.</span>
            </span>
          </h1>
          <p className="mt-5 max-w-md text-body-lg">
            You've got more than one private feed. Choose a show to get its
            exclusive episodes into your podcast app.
          </p>
        </div>

        <div className="mt-12 hairline" />

        <ul className="rise rise-2 mt-12 grid grid-cols-2 gap-6 sm:grid-cols-3 sm:gap-8">
          {feeds.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onSelect(f.id)}
                className="group flex w-full flex-col text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
              >
                <div
                  className="relative aspect-square w-full overflow-hidden bg-navy-900 shadow-cover ring-1 ring-rule transition duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:-translate-y-1 group-hover:ring-cyan"
                  style={{ transform: "rotate(-1.5deg)" }}
                >
                  {f.image_url ? (
                    <img
                      src={f.image_url}
                      alt={f.name}
                      width={760}
                      height={760}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="flex h-full w-full items-center justify-center font-display text-5xl font-bold text-cyan"
                    >
                      {f.name.charAt(0)}
                    </div>
                  )}
                </div>
                <span className="mt-5 font-display text-[17px] font-bold leading-[1.2] text-fg-strong">
                  {f.name}
                </span>
                <span className="mt-2 inline-flex items-center gap-2 text-body-sm text-fg-muted transition group-hover:text-cyan">
                  Set up feed
                  <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
                    →
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
