import { useState } from "react";
import { ARK_DOMAIN, contactEmails } from "../config/urls";

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
    a: `The Ark+ community lives in the Circle app — iOS, Android, and the web. After you join, you'll get a single sign-on link from ${ARK_DOMAIN} straight into the community.`,
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
    a: `Email ${contactEmails.general} and our team will get back to you as quickly as possible.`,
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
            <h2 className="mt-10 text-fg-strong">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                Frequently
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                <span className="display text-cyan">asked.</span>
              </span>
            </h2>
            <p className="mt-8 max-w-sm text-[15px] leading-[1.6] text-fg-muted">
              Everything you need to know before joining Ark+. Still stuck?
              Drop us a line.
            </p>
          </div>

          <div className="lg:col-span-8">
            <ul className="border-t border-rule">
              {faqs.map((f, i) => {
                const isOpen = open === i;
                const panelId = `faq-panel-${i}`;
                const buttonId = `faq-trigger-${i}`;
                return (
                  <li key={f.q} className="border-b border-rule">
                    <button
                      id={buttonId}
                      onClick={() => setOpen(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      className="flex min-h-12 w-full items-start justify-between gap-6 py-4 text-left transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                    >
                      <span className="display-upright text-[15px] leading-snug text-fg-strong sm:text-[16px]">
                        {f.q}
                      </span>
                      <span
                        className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-[18px] text-fg-strong transition ${
                          isOpen ? "rotate-45 text-cyan" : ""
                        }`}
                        aria-hidden="true"
                      >
                        +
                      </span>
                    </button>
                    <div
                      id={panelId}
                      role="region"
                      aria-labelledby={buttonId}
                      hidden={!isOpen}
                      className="overflow-hidden"
                    >
                      <p className="max-w-2xl pb-5 text-[14px] leading-[1.65] text-fg-muted">
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
