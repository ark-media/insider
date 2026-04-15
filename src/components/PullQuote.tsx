export function PullQuote() {
  return (
    <section className="ark-bg grain-overlay relative border-y border-white/8">
      <div className="mx-auto max-w-[1100px] px-6 py-20 sm:px-10 sm:py-28">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="lg:col-span-2">
            <div
              className="display text-[120px] leading-[0.55] text-cyan"
              aria-hidden
            >
              “
            </div>
          </div>
          <div className="lg:col-span-10">
            <p className="display-upright text-[clamp(1.8rem,3.6vw,3.2rem)] leading-[1.08] text-white">
              I subscribe to three newsletters and one podcast.
              <br />
              This is the podcast.{" "}
              <span className="display text-cyan">It's the one</span> thing I
              refuse to skip — the Insider feed is how I actually understand
              what happened each week.
            </p>
            <footer className="mt-10 flex items-center gap-4 text-[12px] font-semibold uppercase tracking-[0.22em] text-white/50">
              <span className="h-px w-10 bg-cyan" />
              R. Mendelsohn · Insider since 2024
            </footer>
          </div>
        </div>
      </div>
    </section>
  );
}
