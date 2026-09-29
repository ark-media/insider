import { Link } from "@tanstack/react-router";
import { formatCalendarDate } from "../../shared/format-date";
import type { ReactNode } from "react";
import type { LegalBlock, LegalDoc } from "../data/legal";
import { PageShell } from "./PageShell";

/**
 * Shared layout for /privacy and /terms — a single measured column of prose,
 * the "last updated" stamp these pages are expected to carry, and (while the
 * doc is a `draft`) an unmissable notice that the text is not the real policy.
 */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <PageShell title={doc.title} lede={doc.lede}>
      <section>
        <div className="page-section">
          <div className="mx-auto max-w-2xl">
            <p className="label text-fg-muted">
              Last updated {formatCalendarDate(doc.lastUpdated, "long")}
            </p>

            {doc.draft ? (
              <div className="mt-6 border-l-2 border-cyan bg-navy-800/40 p-5">
                <p className="label text-cyan">Placeholder</p>
                <p className="mt-3 text-body-sm text-fg">
                  This page is a skeleton, not a policy. The headings below show
                  what the finished document will cover; the text under each one
                  describes the section rather than stating it. Ark Media&apos;s
                  final copy replaces all of it before launch.
                </p>
              </div>
            ) : null}

            <div className="mt-10 space-y-10">
              {doc.sections.map((s) => (
                <div key={s.heading}>
                  <h2 className="text-h3">{s.heading}</h2>
                  {s.body.map((b, i) => (
                    <Block key={i} block={b} />
                  ))}
                </div>
              ))}
            </div>

            <p className="mt-12 border-t border-rule pt-6 text-body-sm">
              Questions about this page?{" "}
              <Link
                to="/contact"
                className="underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Get in touch.
              </Link>
            </p>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function Block({ block }: { block: LegalBlock }) {
  if (typeof block === "string") {
    return <p className="mt-4 text-body-sm text-fg">{inline(block)}</p>;
  }
  if ("subheading" in block) {
    return <h3 className="mt-8 text-h5">{inline(block.subheading)}</h3>;
  }
  return (
    <ul className="mt-4 list-disc space-y-2 pl-5 text-body-sm text-fg">
      {block.list.map((item, i) =>
        typeof item === "string" ? (
          <li key={i}>{inline(item)}</li>
        ) : (
          <li key={i}>
            {inline(item.text)}
            <ul className="mt-2 list-[circle] space-y-2 pl-5">
              {item.items.map((sub, j) => (
                <li key={j}>{inline(sub)}</li>
              ))}
            </ul>
          </li>
        ),
      )}
    </ul>
  );
}

const LINK_CLASS =
  "underline decoration-current underline-offset-4 break-words transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

// `**bold**`, bare http(s) URLs, and email addresses. A URL's trailing
// sentence punctuation stays outside the link.
const TOKEN = /(\*\*[^*]+\*\*|https?:\/\/[^\s]+?(?=[.,;:)]?(?:\s|$))|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

function inline(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith("**")) {
      return (
        <strong key={i} className="text-fg-strong">
          {part.slice(2, -2)}
        </strong>
      );
    }
    const href = part.startsWith("http") ? part : `mailto:${part}`;
    return (
      <a
        key={i}
        href={href}
        className={LINK_CLASS}
        {...(part.startsWith("http")
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        {part}
      </a>
    );
  });
}
