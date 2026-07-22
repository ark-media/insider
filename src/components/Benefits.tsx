import { useSubscriberAuth } from "../lib/subscriberAuth";
import { plusAudience, BENEFITS_CONTENT } from "../data/plusContent";

export function Benefits() {
  // Mirrors the Hero: members see "what <the missing piece> adds" instead of the
  // generic three-benefit pitch. Loading resolves to the guest variant.
  const { state } = useSubscriberAuth();
  const content = BENEFITS_CONTENT[plusAudience(state)];

  return (
    <section id="benefits" className="relative">
      <div className="page-gutter pt-12 pb-16">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="text-fg-strong">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                {content.head.line1}
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                {content.head.line2Pre}
                <span className="display text-cyan">
                  {content.head.line2Accent}
                </span>
                {content.head.line2Post}
              </span>
            </h2>
            <p className="mt-8 max-w-md text-body-sm">{content.intro}</p>
          </div>

          <ol className="lg:col-span-7">
            {content.items.map((b) => (
              <li
                key={b.no}
                className="group grid grid-cols-[auto_1fr] gap-x-8 border-t border-rule py-7 first:border-t-0 first:pt-0 sm:gap-x-14"
              >
                <div className="display-upright text-[20px] text-cyan sm:text-[22px]">
                  {b.no}
                </div>
                <div className="max-w-[54ch]">
                  <h3 className="display-upright text-[20px] leading-tight text-fg-strong sm:text-[22px]">
                    {b.title}
                  </h3>
                  <p className="mt-3 text-body-sm">{b.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
