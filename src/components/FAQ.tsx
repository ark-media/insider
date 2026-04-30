import { useState } from "react";

const faqs = [
  {
    q: "Is this one membership or multiple?",
    a: "One. Ark+ is a single membership — one bill, one login — that covers Inside Call Me Back, members-only newsletters, the community, and live events. No fragmented platforms. No separate subscriptions to keep track of.",
  },
  {
    q: "Can I still listen to Call Me Back for free?",
    a: "Yes. Call Me Back continues to drop free episodes every Sunday and Thursday. Ark+ adds Inside Call Me Back — extended interviews, ad-free episodes, and members-only Q&As — alongside everything else in the bundle.",
  },
  {
    q: "How do I listen to Inside Call Me Back?",
    a: "After you join, you'll get a private RSS feed and one-tap setup links for Apple Podcasts, Overcast, Pocket Casts, Spotify, and most other major podcast apps. Episodes show up automatically, just like the free feed.",
  },
  {
    q: "Where does the community live?",
    a: "The Ark+ community lives in the Circle app — iOS, Android, and the web. After you join, you'll get a single sign-on link from arkmedia.org straight into the community.",
  },
  {
    q: "What are my payment options?",
    a: "Monthly or annual, or name a higher amount to support the work. We accept all major credit and debit cards, plus Apple Pay and Google Pay where available. Checkout is processed by Stripe.",
  },
  {
    q: "How do I cancel?",
    a: "From your member dashboard at any time. Your access continues through the end of the current billing period.",
  },
  {
    q: "Can I gift Ark+?",
    a: "Yes. Gift Ark+ for 6 months or 1 year — see the Gift Ark+ page. Gifts are one-time payments, not auto-renewing subscriptions, and the recipient gets a code by email the moment payment clears.",
  },
  {
    q: "Who do I contact for support?",
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
              Everything you need to know before joining Ark+. Still stuck?
              Drop us a line.
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
