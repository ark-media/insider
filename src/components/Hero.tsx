export function Hero() {
  return (
    <section className="ark-bg grain-overlay relative overflow-hidden">
      <div className="relative mx-auto grid max-w-[1280px] grid-cols-1 gap-12 px-6 pt-14 pb-20 sm:px-10 sm:pt-16 lg:grid-cols-12 lg:gap-10 lg:pt-24 lg:pb-28">
        {/* Left — headline */}
        <div className="relative z-10 lg:col-span-7">
          <div className="rise rise-1 flex items-center gap-3 text-[12px] font-semibold uppercase tracking-[0.22em] text-cyan">
            <span className="h-px w-10 bg-cyan" />
            The Call Me Back Insider
          </div>

          <h1 className="rise rise-2 mt-8 text-white">
            <span className="display-upright block text-[clamp(2.2rem,5.2vw,4.6rem)]">
              The conversation
            </span>
            <span className="display-upright block text-[clamp(2.2rem,5.2vw,4.6rem)]">
              after the{" "}
              <span className="display text-cyan">cameras</span>
            </span>
            <span className="display-upright block text-[clamp(2.2rem,5.2vw,4.6rem)]">
              stop rolling.
            </span>
          </h1>

          <p className="rise rise-3 mt-8 max-w-lg text-[15px] leading-[1.6] text-white/75">
            Join Dan Senor, Nadav Eyal and Amit Segal for the off-record
            debriefs, subscriber-only Q&amp;As and full-length interviews that
            never make the public feed.{" "}
            <span className="text-white">$8/month. No ads. No filler.</span>
          </p>

          <div className="rise rise-4 mt-10 flex flex-wrap items-center gap-6">
            <a
              href="#pricing"
              className="group relative inline-flex items-center gap-3 bg-cyan px-6 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-white"
            >
              Become an Insider
              <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
                →
              </span>
            </a>
            <a
              href="#preview"
              className="text-[15px] text-white/75 underline decoration-white/25 underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan"
            >
              Listen to a sample episode
            </a>
          </div>

          {/* Listening platforms */}
          <div className="rise rise-5 mt-14 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px] text-white/55">
            <span className="font-semibold uppercase tracking-[0.22em] text-white/40">
              Listen on
            </span>
            <span className="h-3 w-px bg-white/20" />
            {["Apple Podcasts", "Spotify", "Overcast", "Pocket Casts", "YouTube", "RSS"].map((p) => (
              <a key={p} href="#" className="transition hover:text-cyan">
                {p}
              </a>
            ))}
          </div>
        </div>

        {/* Right — podcast artwork */}
        <div className="relative lg:col-span-5">
          <div className="rise rise-2 relative mx-auto max-w-[380px]">
            <div
              className="relative aspect-square overflow-hidden"
              style={{
                boxShadow:
                  "0 40px 100px -30px rgba(0,0,0,0.7), 0 8px 30px -10px rgba(0,0,0,0.5)",
                transform: "rotate(-1.5deg)",
              }}
            >
              <img
                src="/inside-cmb.jpg"
                alt="Inside Call Me Back — podcast cover"
                className="h-full w-full object-cover"
              />
            </div>

            {/* Floating subscriber badge */}
            <div
              className="absolute -bottom-6 -left-4 rotate-[4deg] bg-navy-900 px-5 py-3 text-white ring-1 ring-cyan/40"
              style={{
                boxShadow: "0 20px 50px -20px rgba(0,0,0,0.8)",
              }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Subscriber Feed
              </div>
              <div className="display-upright mt-1 text-[22px]">
                No. 00214
              </div>
            </div>

            {/* Corner mark */}
            <div className="absolute -top-5 -right-5 inside-tab text-[14px]">
              New
            </div>
          </div>
        </div>
      </div>

      {/* Bottom cyan hairline */}
      <div className="hairline" />
    </section>
  );
}
