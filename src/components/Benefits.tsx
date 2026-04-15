const benefits = [
  {
    no: "01",
    title: "The off-record debrief",
    body: "Every episode is followed by a 15–25 minute unedited conversation — the arguments, asides and second thoughts that don't make the public cut.",
  },
  {
    no: "02",
    title: "Subscriber Q&A",
    body: "Send your questions for Dan, Nadav and Amit. A standing subscriber-only episode every other week answers as many as we can fit.",
  },
  {
    no: "03",
    title: "Full interviews, unedited",
    body: "Hear the complete two-hour sessions with prime ministers, generals and correspondents — not the 55-minute broadcast edit.",
  },
  {
    no: "04",
    title: "An ad-free feed",
    body: "A private RSS feed. No host reads. No mid-rolls. No pre-rolls. Ever.",
  },
];

export function Benefits() {
  return (
    <section id="benefits" className="relative bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 pt-20 pb-24 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="inside-tab text-[13px]">What's inside</div>
            <h2 className="mt-10 text-white">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                Four things
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                you <span className="display text-cyan">won't</span> get
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                on the free feed.
              </span>
            </h2>
          </div>

          <ol className="lg:col-span-7">
            {benefits.map((b) => (
              <li
                key={b.no}
                className="group grid grid-cols-[auto_1fr] gap-x-8 border-t border-white/12 py-7 first:border-t-0 first:pt-0 sm:gap-x-14"
              >
                <div className="display-upright text-[20px] text-cyan sm:text-[22px]">
                  {b.no}
                </div>
                <div className="max-w-[54ch]">
                  <h3 className="display-upright text-[20px] leading-tight text-white sm:text-[22px]">
                    {b.title}
                  </h3>
                  <p className="mt-3 text-[14px] leading-[1.6] text-white/65">
                    {b.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
