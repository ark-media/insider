// Public FAQ data. The answer arrives already sanitized by the server
// (server/lib/faqs.ts), so the FAQ section can hand it straight to
// html-react-parser without re-sanitizing.

export type { Faq } from "../../shared/faq";
import type { Faq } from "../../shared/faq";

export async function fetchFaqs(): Promise<Faq[]> {
  try {
    const res = await fetch("/api/faqs");
    if (!res.ok) return [];
    const data = (await res.json()) as { faqs: Faq[] };
    return data.faqs ?? [];
  } catch {
    return [];
  }
}

/**
 * The same fetch, but a failure REJECTS instead of degrading to `[]`.
 *
 * `fetchFaqs()` is right for the FAQ section, where "no data" and "no section"
 * are the same outcome and a silent empty is the graceful one. It is wrong for
 * the help widget, whose entire value is searching that data: an empty index
 * there is a total failure wearing the costume of a working UI (a search box
 * that answers "nothing found" to every question). The widget needs to tell the
 * two apart so it can offer a retry — and `useAsyncResource` can only report
 * `error` for a loader that actually rejects.
 */
export async function fetchFaqsOrThrow(): Promise<Faq[]> {
  const res = await fetch("/api/faqs");
  if (!res.ok) throw new Error(`/api/faqs failed (${res.status})`);
  const data = (await res.json()) as { faqs?: Faq[] };
  return data.faqs ?? [];
}
