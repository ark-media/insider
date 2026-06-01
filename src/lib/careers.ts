// Public careers data. The description arrives already sanitized by the server
// (server/lib/careers.ts), so the detail page can hand it straight to
// html-react-parser without re-sanitizing.

export type { Career } from "../../shared/career";
import type { Career } from "../../shared/career";

export async function fetchCareers(): Promise<Career[]> {
  try {
    const res = await fetch("/api/careers");
    if (!res.ok) return [];
    const data = (await res.json()) as { careers: Career[] };
    return data.careers ?? [];
  } catch {
    return [];
  }
}

export async function fetchCareer(slug: string): Promise<Career | null> {
  try {
    const res = await fetch(`/api/careers?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { career: Career | null };
    return data.career ?? null;
  } catch {
    return null;
  }
}

// Block-level tags the editor preview keeps (a superset matching the server's
// description allowlist in server/lib/careers.ts).
const PREVIEW_TAGS = new Set([
  "P", "BR", "STRONG", "B", "EM", "I", "U", "S", "A",
  "UL", "OL", "LI", "H2", "H3", "H4", "BLOCKQUOTE",
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Display-only sanitizer for the editor preview, approximating the server's
// description allowlist. NOT a security boundary — the authoritative sanitize
// runs server-side on save. Uses the browser's DOM parser, so it adds no bundle
// weight and never executes the input.
export function sanitizeRichPreview(html: string): string {
  if (typeof window === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const render = (node: Node): string => {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escapeHtml(child.textContent ?? "");
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as Element;
      const tag = el.tagName;
      if (tag === "BR") {
        out += "<br>";
        return;
      }
      if (!PREVIEW_TAGS.has(tag)) {
        out += render(el); // drop the tag, keep its text
        return;
      }
      const inner = render(el);
      if (tag === "A") {
        const href = el.getAttribute("href") ?? "";
        const safe = /^(https?:|mailto:|\/)/i.test(href) && !href.startsWith("//");
        out += `<a href="${safe ? escapeHtml(href) : "#"}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
      } else {
        const t = tag.toLowerCase();
        out += `<${t}>${inner}</${t}>`;
      }
    });
    return out;
  };
  return render(doc.body);
}
