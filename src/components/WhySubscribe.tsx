// Mission pitch on /plus: why membership matters beyond the perks — sustaining
// independent journalism. Sits below Pricing; structure mirrors the Sam Harris
// "better room for conversation" block (eyebrow → headline → two body paras),
// with Ark Media voice and design tokens.

export function WhySubscribe() {
  return (
    <section id="why-subscribe" className="relative border-t border-rule-soft">
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
            Ark Media is a dedicated place for curious minds to follow hard
            questions about Jewish life, Israel, and a rapidly changing world —
            and to fund the journalism that asks them. Your membership keeps the
            work free from the pressures that reshape most newsrooms:
            advertisers chasing clicks, platforms optimizing for outrage, owners
            with agendas.
          </p>

          <p className="mt-5 text-body-sm text-fg">
            This isn’t another media brand built for the algorithm. It’s a small
            independent network — podcasts, writing, and community — organized
            around shared curiosity and the assumption that serious conversation
            still matters. Subscribe to get the full Ark+ experience, and to
            keep that work answering to its audience.
          </p>
        </div>
      </div>
    </section>
  );
}
