import { Link } from "@tanstack/react-router";
import { formatCalendarDate } from "../../shared/format-date";
import { DRAFT, LAST_UPDATED, type LegalDoc } from "../data/legal";
import { PageShell } from "./PageShell";

/**
 * Shared layout for /privacy and /terms — a single measured column of prose,
 * the "last updated" stamp these pages are expected to carry, and (while
 * `DRAFT`) an unmissable notice that the text is not the real policy.
 */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <PageShell title={doc.title} lede={doc.lede}>
      <section>
        <div className="page-section">
          <div className="mx-auto max-w-2xl">
            <p className="label text-fg-muted">
              Last updated {formatCalendarDate(LAST_UPDATED, "long")}
            </p>

            {DRAFT ? (
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
                  {s.body.map((p) => (
                    <p key={p} className="mt-4 text-body-sm text-fg">
                      {p}
                    </p>
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
