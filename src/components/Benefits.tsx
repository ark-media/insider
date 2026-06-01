const benefits = [
  {
    no: "01",
    title: "Call Me Back Ark+ Feed",
    body: "Extra weekly episode, ad-free episodes, and members-only Q&As — delivered as a private feed in the podcast app you already use.",
  },
  {
    no: "02",
    title: "Members-only newsletter",
    body: "A weekly Ark+ members newsletter with our full analysis, source notes, and more, delivered straight to your inbox.",
  },
  {
    no: "03",
    title: "The Ark Community",
    body: "Full access to the Ark community app, exclusive members-only spaces, and opportunities to connect with fellow members — plus access to Inside Call Me Back Q&A sessions.",
  },
];

export function Benefits() {
  return (
    <section id="benefits" className="relative">
      <div className="page-gutter pt-12 pb-16">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="text-fg-strong">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                Three things,
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                <span className="display text-cyan">one</span> membership.
              </span>
            </h2>
            <p className="mt-8 max-w-md text-body-sm">
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
                  <p className="mt-3 text-body-sm">
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
