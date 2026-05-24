const benefits = [
  {
    no: "01",
    title: "Inside Call Me Back",
    body: "Extended interviews, ad-free episodes, members-only Q&As, and the full archive — delivered as a private feed in the podcast app you already use.",
  },
  {
    no: "02",
    title: "Members-only newsletters",
    body: "A weekly Ark+ members letter with sharper analysis, source notes, and what we're reading. Plus full archives of every Ark Media newsletter, paid and free.",
  },
  {
    no: "03",
    title: "The Ark+ community",
    body: "Nadav, Amit and Tal in the room with members in the Circle app. Discussion threads, watch parties, and live audio events — not a comments section.",
  },
  {
    no: "04",
    title: "Live events & early access",
    body: "Audio rooms, video AMAs, and member-priority access to live recordings. New shows land in the Ark+ feed first.",
  },
];

export function Benefits() {
  return (
    <section id="benefits" className="relative bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 pt-20 pb-24 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="inside-tab text-[13px]">What's included</div>
            <h2 className="mt-10 text-fg-strong">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                Four things,
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                <span className="display text-cyan">one</span> membership.
              </span>
            </h2>
            <p className="mt-8 max-w-md text-[14px] leading-[1.6] text-fg-muted">
              No fragmented platforms, no separate logins, no FAQ explaining
              why Discord is locked to Substack. One Ark+ membership covers
              everything below.
            </p>
          </div>

          <ol className="lg:col-span-7">
            {benefits.map((b) => (
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
                  <p className="mt-3 text-[14px] leading-[1.6] text-fg-muted">
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
