import { useState } from "react";

const faqs = [
  {
    q: "Can I still listen to Call me Back for free, or do I need a paid subscription?",
    a: "Yes. The Call me Back feed is free. New episodes drop every Monday and Thursday. Inside Call me Back grants you access to an extra episode every Friday, featuring Dan, Nadav Eyal, and Amit Segal answering listener questions.",
  },
  {
    q: "Can I listen to Inside Call me Back on my favorite podcasting app?",
    a: "Once you subscribe, you'll receive a private RSS feed that works in Apple Podcasts, Overcast, Pocket Casts, Spotify, and most other major podcast apps.",
  },
  {
    q: "What do I need to do to join Inside Call me Back?",
    a: "Pick a plan above, complete checkout via Supporting Cast, and you'll get instructions for adding the private feed to your podcast app of choice.",
  },
  {
    q: "What are my payment options?",
    a: "You can pay monthly or annually, or name a higher amount to support the show. All plans include the same Insider benefits.",
  },
  {
    q: "What types of payment do you accept?",
    a: "We accept all major credit and debit cards, plus Apple Pay and Google Pay where available, securely processed through Supporting Cast.",
  },
  {
    q: "How do I cancel my Inside Call me Back subscription?",
    a: "You can cancel anytime from your account settings. Your access continues through the end of the current billing period.",
  },
  {
    q: "Who do I reach out to for additional support?",
    a: "Email hello@arkmedia.org and our team will get back to you as quickly as possible.",
  },
];

export function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="relative bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-20 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <div className="inside-tab text-[13px]">The fine print</div>
            <h2 className="mt-10 text-white">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                Frequently
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                <span className="display text-cyan">asked.</span>
              </span>
            </h2>
            <p className="mt-8 max-w-sm text-[15px] leading-[1.6] text-white/60">
              Everything you need to know before joining the Insider feed. Still
              stuck? Drop us a line.
            </p>
          </div>

          <div className="lg:col-span-8">
            <ul className="border-t border-white/12">
              {faqs.map((f, i) => {
                const isOpen = open === i;
                return (
                  <li key={f.q} className="border-b border-white/12">
                    <button
                      onClick={() => setOpen(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      className="flex w-full items-start justify-between gap-6 py-5 text-left transition hover:text-cyan"
                    >
                      <span className="display-upright text-[15px] leading-snug text-white sm:text-[16px]">
                        {f.q}
                      </span>
                      <span
                        className={`mt-1 inline-flex size-6 shrink-0 items-center justify-center border border-white/30 text-[14px] text-white transition ${
                          isOpen ? "rotate-45 border-cyan text-cyan" : ""
                        }`}
                        aria-hidden
                      >
                        +
                      </span>
                    </button>
                    <div
                      className={`grid overflow-hidden transition-all duration-500 ease-[cubic-bezier(.16,1,.3,1)] ${
                        isOpen ? "grid-rows-[1fr] pb-5" : "grid-rows-[0fr]"
                      }`}
                    >
                      <p className="min-h-0 max-w-2xl text-[13.5px] leading-[1.65] text-white/65">
                        {f.a}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
