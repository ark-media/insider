// Mission pitch on /plus: why membership matters beyond the perks — sustaining
// independent journalism. Sits below Pricing; structure mirrors the Sam Harris
// "better room for conversation" block (eyebrow → headline → two body paras),
// with Ark Media voice and design tokens.

export function WhySubscribe() {
  return (
    <section id="why-subscribe" className="relative">
      <div className="page-gutter pt-12 pb-16">
        <div className="mx-auto max-w-2xl">
          <div className="eyebrow text-cyan">Why subscribe</div>

          <h2 className="mt-5 text-fg-strong">
            <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
              Independent journalism,
            </span>
            <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
              sustained by <span className="display text-cyan">you.</span>
            </span>
          </h2>

          <p className="mt-8 text-body-sm text-fg">
            There's never been more coverage of Israel and the Jewish world. And yet, there's never been less of it worth trusting. But because our Members fund most of what we do here at Ark Media, we're free to cover the stories that need to be told, honestly and without compromise. When you become a paid member you support that mission and keep these conversations going.
          </p>
        </div>
      </div>
    </section>
  );
}
