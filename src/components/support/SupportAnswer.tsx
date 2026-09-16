import parse from "html-react-parser";
import type { Faq } from "../../lib/faqs";

// The answer arrives already sanitized by the server (server/lib/faqs.ts
// re-sanitizes on the way OUT, not just on the way in), so it goes straight to
// html-react-parser — the same contract FAQ.tsx relies on.
//
// Prose styling is a narrowed version of the /faq accordion's: the same tag
// coverage, sized for a ~360px panel rather than a two-column page.
const ANSWER_PROSE = [
  "[&_p]:mb-3 [&_p:last-child]:mb-0",
  "[&_a]:text-cyan [&_a]:underline [&_a]:underline-offset-[3px] [&_a]:break-words",
  "[&_strong]:text-fg-strong [&_b]:text-fg-strong",
  "[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
  "[&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
  "[&_li]:ml-1",
  "[&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-[15px] [&_h2]:text-fg-strong",
  "[&_h3]:mt-3 [&_h3]:font-semibold [&_h3]:text-fg-strong",
  "[&_h4]:mt-2 [&_h4]:font-semibold [&_h4]:text-fg-strong",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-rule-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted",
].join(" ");

/**
 * The body of one answer, without its question — the disclosure row above it is
 * already showing that, and repeating it wasted the top third of a phone-sized
 * panel restating what the member just tapped. The category stays: it is the
 * only orientation an answer carries once it is lifted out of the /faq page's
 * two-level accordion.
 */
export function SupportAnswer({ faq }: { faq: Faq }) {
  return (
    <div>
      {faq.category ? <p className="eyebrow text-cyan">{faq.category}</p> : null}
      <div className={`mt-2 text-body-sm ${ANSWER_PROSE}`}>{parse(faq.answer)}</div>
    </div>
  );
}
