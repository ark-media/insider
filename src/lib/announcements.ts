// Public announcement banner data. The body arrives already sanitized by the
// server (server/lib/announcements.ts), so the banner can hand it straight to
// html-react-parser without re-sanitizing.

export type { Announcement } from "../../shared/announcement";
import type { Announcement } from "../../shared/announcement";

export async function fetchActiveAnnouncement(): Promise<Announcement | null> {
  try {
    const res = await fetch("/api/announcements/active");
    if (!res.ok) return null;
    const data = (await res.json()) as { announcement: Announcement | null };
    return data.announcement ?? null;
  } catch {
    return null;
  }
}

const PREVIEW_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "A", "BR"]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Display-only sanitizer for the editor preview, approximating the server's
// inline allowlist (server/lib/announcements.ts). NOT a security boundary —
// the authoritative sanitize runs server-side on save. Uses the browser's DOM
// parser, so it adds no bundle weight and never executes the input.
export function sanitizeInlinePreview(html: string): string {
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
