// Shared client-side helpers for admin rich text. Both the WYSIWYG editor and
// every "Preview" box use these, so all three back-office editors (FAQs,
// careers, announcements) look and behave identically.

// Tailwind utility classes that style rendered rich text — paragraph spacing,
// list markers, heading sizes, link color, blockquotes. Applied to the editor's
// editing surface and the preview boxes so "what you type" matches "what saves."
// Mirrors the tag set in the server allowlist (server/lib/richText.ts).
export const RICH_TEXT_CLASS = [
  "[&_p]:mb-2 [&_p:last-child]:mb-0",
  "[&_a]:text-cyan [&_a]:underline",
  "[&_strong]:text-fg-strong [&_b]:text-fg-strong",
  "[&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
  "[&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_li]:ml-1",
  "[&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-[18px] [&_h2]:text-fg-strong",
  "[&_h3]:mt-3 [&_h3]:font-semibold [&_h3]:text-fg-strong",
  "[&_h4]:mt-2 [&_h4]:font-semibold [&_h4]:text-fg-strong",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-rule-strong [&_blockquote]:pl-4 [&_blockquote]:text-fg-muted",
].join(" ");

// Block/inline tags the preview keeps — the same set the server allows, so the
// preview faithfully approximates the saved output.
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
// allowlist (server/lib/richText.ts). NOT a security boundary — the
// authoritative sanitize runs server-side on save. Uses the browser's DOM
// parser, so it adds no bundle weight and never executes the input.
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
