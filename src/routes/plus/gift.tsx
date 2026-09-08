import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { GiftCheckoutModal } from "../../components/GiftCheckoutModal";
import {
  GIFT_LABEL,
  GIFT_PRICE_DOLLARS,
  GIFT_TIER_BLURB,
  GIFT_TIER_LABEL,
  type GiftInput,
  type GiftTerm,
  type GiftTier,
} from "../../lib/gift";
import { trackEvent } from "../../lib/analytics";

export const Route = createFileRoute("/plus/gift")({
  component: GiftPage,
});

const inputClass =
  "w-full border border-rule-strong bg-transparent px-3 py-2.5 text-fg-strong placeholder:text-fg-muted outline-none transition focus:border-cyan disabled:opacity-50";

const GIFT_TIERS = ["ark-plus", "circle", "bundle"] as const;
const GIFT_TERMS = ["6mo", "1yr"] as const;

// The next index a roving-tabindex arrow/Home/End keypress lands on, or null if
// the key isn't a navigation key. Shared by the tier + term radiogroups; the
// caller focuses/selects it (refs are read in the event handler, never render).
function nextRovingIndex(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function GiftPage() {
  const [tier, setTier] = useState<GiftTier>("ark-plus");
  const [term, setTerm] = useState<GiftTerm>("1yr");
  const [giverName, setGiverName] = useState("");
  const [giverEmail, setGiverEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState<GiftInput | null>(null);
  const tierRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const termRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onTierKeyDown = (e: React.KeyboardEvent, index: number) => {
    const next = nextRovingIndex(e.key, index, GIFT_TIERS.length);
    if (next === null) return;
    e.preventDefault();
    setTier(GIFT_TIERS[next]);
    tierRefs.current[next]?.focus();
  };
  const onTermKeyDown = (e: React.KeyboardEvent, index: number) => {
    const next = nextRovingIndex(e.key, index, GIFT_TERMS.length);
    if (next === null) return;
    e.preventDefault();
    setTerm(GIFT_TERMS[next]);
    termRefs.current[next]?.focus();
  };

  const canSubmit =
    giverEmail.trim().length > 0 &&
    recipientEmail.trim().length > 0 &&
    (term === "6mo" || term === "1yr");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    trackEvent("gift_checkout_opened", { tier, term });
    setSubmitted({
      giverEmail: giverEmail.trim(),
      giverName: giverName.trim() || undefined,
      recipientEmail: recipientEmail.trim(),
      recipientName: recipientName.trim() || undefined,
      tier,
      term,
      message: message.trim() || undefined,
    });
  };

  return (
    <>
      <section className="section-hero ark-bg grain-overlay relative overflow-hidden">
        <div className="page-gutter relative pt-10 pb-16 lg:pt-16">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-8">
            {/* Left: pitch */}
            <div className="lg:col-span-5">
              <div className="rise rise-1 flex items-center gap-3 eyebrow">
                <span className="h-px w-10 bg-cyan" />
                Give a membership
              </div>
              <h1 className="rise rise-2 mt-8 text-fg-strong">
                <span className="display-upright block text-[clamp(2rem,4.4vw,3.4rem)]">
                  Give the full
                </span>
                <span className="display-upright block text-[clamp(2rem,4.4vw,3.4rem)]">
                  Ark Media{" "}
                  <span className="display text-cyan">experience.</span>
                </span>
              </h1>
              <p className="rise rise-3 mt-8 max-w-md text-body-lg text-fg">
                Pick Ark+ for the exclusive content, ad-free feed and members-only
                newsletters, the Fold, or the Bundle of both. It's a
                one-time gift — no renewals, no surprise charges — and they'll
                get an email with everything they need to start.
              </p>
              <ul className="rise rise-4 mt-10 space-y-2 text-body-sm text-fg">
                <li className="flex items-start gap-3">
                  <span className="mt-[8px] inline-block h-px w-4 bg-cyan" />
                  A one-time gift — it never renews or charges again
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-[8px] inline-block h-px w-4 bg-cyan" />
                  Lands in their inbox within minutes
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-[8px] inline-block h-px w-4 bg-cyan" />
                  Encrypted, secure checkout
                </li>
              </ul>
            </div>

            {/* Right: form */}
            <div className="rise rise-3 lg:col-span-7">
              <form
                onSubmit={onSubmit}
                className="border border-rule-strong bg-navy-800/60 p-5 shadow-cover backdrop-blur-sm sm:p-8"
              >
                <div className="label text-fg-strong">
                  Choose a membership
                </div>
                <div
                  role="radiogroup"
                  aria-label="Gift tier"
                  className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3"
                >
                  {GIFT_TIERS.map((t, i) => {
                    const selected = tier === t;
                    return (
                      <button
                        key={t}
                        ref={(el) => {
                          tierRefs.current[i] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => setTier(t)}
                        onKeyDown={(e) => onTierKeyDown(e, i)}
                        className={`group flex flex-col items-start gap-1 border px-4 py-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                          selected
                            ? "border-cyan bg-cyan text-navy"
                            : "border-rule-strong text-fg-strong hover:border-cyan"
                        }`}
                      >
                        <span className="button-text font-display font-bold tracking-cta">
                          {GIFT_TIER_LABEL[t]}
                        </span>
                        <span
                          className={`text-body-sm leading-snug ${
                            selected ? "text-inherit opacity-90" : "text-fg"
                          }`}
                        >
                          {GIFT_TIER_BLURB[t]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-8 label text-fg-strong">
                  Choose a length
                </div>
                <div
                  role="radiogroup"
                  aria-label="Gift length"
                  className="mt-3 grid grid-cols-2 gap-2 sm:gap-3"
                >
                  {GIFT_TERMS.map((t, i) => {
                    const selected = term === t;
                    return (
                      <button
                        key={t}
                        ref={(el) => {
                          termRefs.current[i] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => setTerm(t)}
                        onKeyDown={(e) => onTermKeyDown(e, i)}
                        className={`group flex flex-col items-center gap-1 border px-4 py-6 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                          selected
                            ? "border-cyan bg-cyan text-navy"
                            : "border-rule-strong text-fg-strong hover:border-cyan"
                        }`}
                      >
                        <span className="display-upright text-[clamp(2.2rem,4vw,2.8rem)] leading-none">
                          ${GIFT_PRICE_DOLLARS[tier][t]}
                        </span>
                        <span
                          className={`button-text font-semibold ${
                            selected ? "opacity-90" : "text-fg"
                          }`}
                        >
                          {GIFT_LABEL[t]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-8 label text-fg-strong">
                  From
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="sr-only">Your name (optional)</span>
                    <input
                      type="text"
                      value={giverName}
                      onChange={(e) => setGiverName(e.target.value)}
                      placeholder="Your name (optional)"
                      className={inputClass}
                    />
                  </label>
                  <label className="block">
                    <span className="sr-only">Your email</span>
                    <input
                      type="email"
                      required
                      value={giverEmail}
                      onChange={(e) => setGiverEmail(e.target.value)}
                      placeholder="Your email"
                      className={inputClass}
                    />
                  </label>
                </div>

                <div className="mt-6 label text-fg-strong">
                  To
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="sr-only">Recipient's name (optional)</span>
                    <input
                      type="text"
                      value={recipientName}
                      onChange={(e) => setRecipientName(e.target.value)}
                      placeholder="Recipient's name (optional)"
                      className={inputClass}
                    />
                  </label>
                  <label className="block">
                    <span className="sr-only">Recipient's email</span>
                    <input
                      type="email"
                      required
                      value={recipientEmail}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                      placeholder="Recipient's email"
                      className={inputClass}
                    />
                  </label>
                </div>

                <div className="mt-6">
                  <label className="block">
                    <span className="label text-fg-strong">
                      Message (optional)
                    </span>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={3}
                      maxLength={500}
                      placeholder="Add a note for the recipient"
                      className={`${inputClass} mt-3 resize-y`}
                    />
                  </label>
                  <div
                    className={`mt-1 text-right text-body-sm tabular-nums ${
                      message.length >= 450 ? "text-cyan" : "text-fg-muted"
                    }`}
                    aria-live="polite"
                  >
                    {message.length} / 500
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="group mt-8 inline-flex min-h-12 w-full items-center justify-between bg-cyan px-5 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                >
                  Continue to payment · ${GIFT_PRICE_DOLLARS[tier][term]}
                  <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                    →
                  </span>
                </button>
                <p className="mt-3 text-body-sm text-fg">
                  As soon as you check out, we'll email them a link to start
                  their membership.
                </p>
              </form>
            </div>
          </div>
        </div>
      </section>

      <GiftCheckoutModal
        open={submitted !== null}
        input={submitted}
        onClose={() => setSubmitted(null)}
      />
    </>
  );
}
