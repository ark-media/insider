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
