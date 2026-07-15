import { CommunityAppLinks } from "./CommunityAppLinks";
import { circleUrls } from "../config/urls";
import { trackEvent } from "../lib/analytics";

// Circle is billed by Circle, not by us — there's no Stripe Price behind this
// number for /api/pricing to read, so unlike the Ark+ plans it has to live in
// the copy. If community pricing changes on Circle's side, change it here too.
const CIRCLE_PRICE = "$2";

const pillars = [
  {
    no: "01",
    title: "The conversation, all week",
    body: "The arguments the episodes start, carried on by the people who listen to them — analysts, veterans, students, and the hosts themselves, in the thread with everyone else.",
  },
  {
    no: "02",
    title: "Member events, live",
    body: "Live discussions and Q&As held in the community — the room where questions get asked out loud instead of shouted into a comments section.",
  },
  {
    no: "03",
    title: "Dan's book club",
    body: "One book at a time, read together, with Dan running the discussion. Slow, serious reading in the middle of a very fast news cycle.",
  },
];

/**
 * The community, sold on its own terms — a peer of the Ark+ pricing section
 * rather than a line item inside it. Membership here is bought from Circle
 * directly; Ark+ members already have it, which is stated once, at the end,
 * where it belongs.
 */
export function CircleCommunity() {
  return (
    <section id="community" className="relative border-t border-rule-soft">
      <div className="page-gutter pt-12 pb-16">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="eyebrow text-cyan">Circle · Community</div>
            <h2 className="mt-5 text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                Somewhere to
              </span>
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                <span className="display text-cyan">argue</span> properly.
              </span>
            </h2>
            <p className="mt-6 max-w-md text-body-sm text-fg">
              Join the Ark Media community. Conversations, member events, and
              Dan's book club — in an app built for talking rather than for going
              viral.
            </p>

            <div className="mt-8 flex items-baseline gap-2 text-fg-strong">
              <span className="display-upright text-[clamp(2.6rem,5vw,3.6rem)] leading-none">
                {CIRCLE_PRICE}
              </span>
              <span className="text-body-sm">/ month</span>
            </div>

            <a
              href={circleUrls.community}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => trackEvent("circle_join_clicked")}
              className="group mt-6 inline-flex min-h-12 w-full items-center justify-between border border-rule-strong px-5 button-text font-display font-bold tracking-cta text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:w-auto sm:gap-8"
            >
              Join Circle
              <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                →
              </span>
            </a>

            <p className="mt-6 max-w-md text-body-sm text-fg-muted">
              Already an Ark+ member? Circle community access is included at no
              extra cost — you don't pay for it twice.
            </p>
          </div>

          <div className="lg:col-span-7">
            <ol>
              {pillars.map((p) => (
                <li
                  key={p.no}
                  className="grid grid-cols-[auto_1fr] gap-x-8 border-t border-rule py-7 first:border-t-0 first:pt-0 sm:gap-x-14"
                >
                  <div className="display-upright text-[20px] text-cyan sm:text-[22px]">
                    {p.no}
                  </div>
                  <div className="max-w-[54ch]">
                    <h3 className="display-upright text-[20px] leading-tight text-fg-strong sm:text-[22px]">
                      {p.title}
                    </h3>
                    <p className="mt-3 text-body-sm">{p.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-8 border-t border-rule pt-7">
              <div className="eyebrow text-fg-muted">Get the app</div>
              <CommunityAppLinks className="mt-4" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
