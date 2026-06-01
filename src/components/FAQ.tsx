import { useState } from "react";
import parse from "html-react-parser";
import type { Faq } from "../lib/faqs";

export function FAQ({ faqs }: { faqs: Faq[] }) {
  const [open, setOpen] = useState<number | null>(null);

  // Nothing published, or the fetch degraded to empty — drop the whole section
  // rather than render an empty heading.
  if (faqs.length === 0) return null;

  return (
    <section id="faq" className="relative">
      <div className="mx-auto max-w-[1280px] px-6 py-20 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="mt-10 text-fg-strong">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                Frequently
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                <span className="display text-cyan">asked.</span>
              </span>
            </h2>
            <p className="mt-8 max-w-sm text-body-lg">
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
                  <li
                    key={f.id}
                    style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
                    className="rise relative border-b border-rule"
                  >
                    {/* Accent rail — scales in from the top edge on the open row */}
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute left-0 top-0 h-full w-[2px] origin-top bg-cyan transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
                        isOpen ? "scale-y-100" : "scale-y-0"
                      }`}
                    />
                    <button
                      id={buttonId}
                      onClick={() => setOpen(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      className={`flex min-h-12 w-full items-start justify-between gap-6 py-4 text-left transition-[color,padding] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan motion-reduce:transition-none ${
                        isOpen ? "pl-4" : "pl-0"
                      }`}
                    >
                      <span
                        className={`display-upright text-body-lg leading-snug transition-colors duration-300 sm:text-base ${
                          isOpen ? "text-cyan" : "text-fg-strong"
                        }`}
                      >
                        {f.question}
                      </span>
                      <span
                        className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-[18px] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${
                          isOpen ? "rotate-[225deg] scale-110 text-cyan" : "text-fg-strong"
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
                      inert={!isOpen}
                      className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
                        isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                      }`}
                    >
                      <div className="overflow-hidden">
                        <div
                          className={`max-w-2xl -mt-2 space-y-3 pb-5 pl-4 text-body-sm transition-opacity duration-300 [&_a]:underline [&_a]:decoration-current [&_a]:underline-offset-[6px] [&_a]:transition hover:[&_a]:text-cyan hover:[&_a]:decoration-cyan [&_li]:ml-1 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 motion-reduce:transition-none ${
                            isOpen ? "opacity-100" : "opacity-0"
                          }`}
                        >
                          {parse(f.answer)}
                        </div>
                      </div>
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
