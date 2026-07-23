import { useState } from "react";
import parse from "html-react-parser";
import { Link } from "@tanstack/react-router";
import type { Faq } from "../lib/faqs";

// Group FAQs into ordered sections by their `category` heading. Input arrives
// sorted by display_order, so first-appearance defines section order and
// within-section order both follow from a Map's insertion order. Uncategorised
// FAQs (empty category) collapse into a single trailing headingless group.
function groupByCategory(faqs: Faq[]): { category: string; items: Faq[] }[] {
  const groups = new Map<string, Faq[]>();
  for (const f of faqs) {
    const arr = groups.get(f.category) ?? [];
    arr.push(f);
    groups.set(f.category, arr);
  }
  return Array.from(groups, ([category, items]) => ({ category, items }));
}

// `as` promotes the section heading to the page's h1 on the standalone /faq
// route, where this section is the whole page. Inline on /plus and /pricing it
// stays an h2 under those pages' own h1.
export function FAQ({ faqs, as: Heading = "h2" }: { faqs: Faq[]; as?: "h1" | "h2" }) {
  // Two independent accordion layers. Sections are collapsed by default (a Set
  // of open category names — several may be open at once). Questions keep the
  // one-at-a-time behaviour, keyed by FAQ id since an index isn't unique across
  // sections.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);

  // Nothing published, or the fetch degraded to empty — drop the whole section
  // rather than render an empty heading.
  if (faqs.length === 0) return null;

  const groups = groupByCategory(faqs);

  const toggleSection = (category: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  const renderQuestions = (items: Faq[]) => (
    <ul>
      {items.map((f, i) => {
        const isOpen = openQuestion === f.id;
        const panelId = `faq-panel-${f.id}`;
        const buttonId = `faq-trigger-${f.id}`;
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
              onClick={() => setOpenQuestion(isOpen ? null : f.id)}
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
                  className={`max-w-2xl -mt-2 space-y-3 pb-5 pl-4 text-body-sm transition-opacity duration-300 [&_a]:underline [&_a]:decoration-current [&_a]:underline-offset-[6px] [&_a]:transition hover:[&_a]:text-cyan hover:[&_a]:decoration-cyan [&_li]:ml-1 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_strong]:text-fg-strong [&_h2]:mt-3 [&_h2]:font-display [&_h2]:text-[16px] [&_h2]:text-fg-strong [&_h3]:mt-2 [&_h3]:font-semibold [&_h3]:text-fg-strong [&_h4]:font-semibold [&_h4]:text-fg-strong [&_blockquote]:border-l-2 [&_blockquote]:border-rule-strong [&_blockquote]:pl-4 [&_blockquote]:text-fg-muted motion-reduce:transition-none ${
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
  );

  return (
    <section id="faq" className="relative">
      <div className="page-section">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <Heading className="mt-10 text-fg-strong">
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                Frequently
              </span>
              <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
                <span className="display text-cyan">asked.</span>
              </span>
            </Heading>
            <p className="mt-8 max-w-sm text-body-lg">
              Everything you need to know before joining Ark+. Still stuck?{" "}
              <Link
                to="/contact"
                className="underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Drop us a line.
              </Link>
            </p>
          </div>

          <div className="lg:col-span-8">
            <div className="border-t border-rule">
              {groups.map((group, gi) => {
                // Ungrouped FAQs render as a plain, always-open list — there's
                // no heading to collapse them under.
                if (!group.category) {
                  return (
                    <div key={`__ungrouped-${gi}`}>{renderQuestions(group.items)}</div>
                  );
                }

                const sectionOpen = openSections.has(group.category);
                const sectionPanelId = `faq-section-${gi}`;
                return (
                  <div key={group.category}>
                    <h3 className="m-0">
                      <button
                        onClick={() => toggleSection(group.category)}
                        aria-expanded={sectionOpen}
                        aria-controls={sectionPanelId}
                        className="flex w-full items-center justify-between gap-6 border-b border-rule py-5 text-left transition-colors duration-200 hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                      >
                        <span
                          className={`display-upright text-[clamp(1.15rem,1.9vw,1.5rem)] transition-colors duration-200 ${
                            sectionOpen ? "text-cyan" : "text-fg-strong"
                          }`}
                        >
                          {group.category}
                        </span>
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          className={`size-5 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
                            sectionOpen ? "rotate-180 text-cyan" : "text-fg-strong"
                          }`}
                        >
                          <path
                            d="M6 9l6 6 6-6"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </h3>
                    <div
                      id={sectionPanelId}
                      role="region"
                      inert={!sectionOpen}
                      className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
                        sectionOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                      }`}
                    >
                      <div className="overflow-hidden">
                        {renderQuestions(group.items)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
