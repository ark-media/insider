// Renders sanitized show-notes HTML into React via html-react-parser.
//
// Trust boundary: input MUST come from `sanitizeShowNotes` (server/show-notes.ts).
// html-react-parser does not re-sanitize — it trusts whatever string we hand it.

import {
  domToReact,
  htmlToDOM,
  type DOMNode,
  type HTMLReactParserOptions,
} from "html-react-parser";
import { OutboundLink } from "../components/OutboundLink";
import { safeHref } from "./safeHref";

// Duck-typed node checks. We can't use `instanceof Element`/`Text` from
// html-react-parser because html-dom-parser ships its own copy of domhandler,
// so parsed nodes don't match the classes we'd import here.
function isTagNode(node: DOMNode): node is DOMNode & {
  name: string;
  attribs: Record<string, string>;
  children: DOMNode[];
} {
  return node.type === "tag";
}

function isTextNode(node: DOMNode): node is DOMNode & { data: string } {
  return node.type === "text";
}

// Simplecast authors type runs like `____` or `---` as visual separators
// between sections. Sanitization strips real <hr>s, so these arrive as bare
// text. Detect a node that is *only* separator glyphs (plus whitespace) so we
// can render it as a proper rule instead of stray underscores on the page.
function isSeparatorText(text: string): boolean {
  return /[_–—*·•=-]/.test(text) && /^[\s_–—*·•=-]+$/.test(text);
}

function hasRenderableContent(children: DOMNode[]): boolean {
  return children.some(
    (c) =>
      (isTextNode(c) && c.data.trim() !== "") ||
      (isTagNode(c) && c.name !== "br"),
  );
}

// Peels trailing <br>, whitespace, and separator runs off the end of a
// paragraph's children — handles the common `<p>…text…<br/> ____</p>` pattern
// where the separator is tacked onto the end of an otherwise real paragraph.
function splitTrailingSeparator(children: DOMNode[]): {
  body: DOMNode[];
  hasSeparator: boolean;
} {
  const body = [...children];
  let hasSeparator = false;
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (isTextNode(last)) {
      const t = last.data;
      if (t.trim() === "") {
        body.pop();
        continue;
      }
      if (isSeparatorText(t)) {
        body.pop();
        hasSeparator = true;
        continue;
      }
      break;
    }
    if (isTagNode(last) && last.name === "br") {
      body.pop();
      continue;
    }
    break;
  }
  return { body, hasSeparator };
}

// A short, brand-cyan rule standing in for the author's `____` separators.
const DIVIDER_CLASS = "my-7 h-[2px] w-10 rounded-full border-0 bg-cyan/40";

// A small cyan tick used as the marker for both real <ul> items and dash-led
// "headline" paragraphs, so the two read as one consistent list style.
const BULLET_MARKER =
  "relative pl-5 before:absolute before:left-0 before:top-[0.62em] before:h-[2px] before:w-[10px] before:rounded-full before:bg-cyan/70 before:content-['']";

// Authors write standalone "headlines" as paragraphs that begin with a hyphen
// or bullet glyph (`<p>- Smotrich responds…</p>`). We give those the same tick
// marker as list items so a run of them reads as a clean list rather than a
// stack of disconnected sentences. En/em dashes are excluded — leading those
// usually means an attribution, not a list item.
const LEADING_BULLET = /^\s*[-•*]\s+/;

const showNotesParserOptions: HTMLReactParserOptions = {
  replace: (node) => {
    if (!isTagNode(node)) return undefined;

    if (node.name === "p") {
      const { body, hasSeparator } = splitTrailingSeparator(node.children);
      // A paragraph that was nothing but a separator run becomes a rule.
      if (!hasRenderableContent(body)) {
        return <hr className={DIVIDER_CLASS} />;
      }
      // Dash-led "headline" paragraph: strip the glyph and render it as a
      // marker line. (Marker classes only *add* properties the parent [&_p]
      // styles don't set, so paragraph spacing still applies.)
      const first = body[0];
      const isBullet = isTextNode(first) && LEADING_BULLET.test(first.data);
      if (isBullet) {
        first.data = first.data.replace(LEADING_BULLET, "");
      }
      // Real content with a separator tacked on: render the content, then the
      // rule. Plain paragraphs with no marker and no separator fall through to
      // the default render so the parent's [&_p] styles still apply.
      if (!isBullet && !hasSeparator) {
        return undefined;
      }
      const content = (
        <p className={isBullet ? BULLET_MARKER : undefined}>
          {domToReact(body, showNotesParserOptions)}
        </p>
      );
      return hasSeparator ? (
        <>
          {content}
          <hr className={DIVIDER_CLASS} />
        </>
      ) : (
        content
      );
    }

    if (node.name === "a") {
      const href = safeHref(
        typeof node.attribs.href === "string" ? node.attribs.href : undefined,
      );
      // Simplecast often nests surrounding spaces inside the anchor
      // (`<a> Inside Call me Back</a>`). Pull them out so the underline hugs
      // the link text instead of bleeding into the gap beside it.
      const kids = node.children;
      let lead = false;
      let trail = false;
      if (kids.length > 0) {
        const first = kids[0];
        if (isTextNode(first) && /^\s/.test(first.data)) {
          lead = true;
          first.data = first.data.replace(/^\s+/, "");
        }
        const last = kids[kids.length - 1];
        if (isTextNode(last) && /\s$/.test(last.data)) {
          trail = true;
          last.data = last.data.replace(/\s+$/, "");
        }
      }
      const children = domToReact(kids, showNotesParserOptions);
      // When sanitize-html strips an unsafe scheme (e.g. javascript:) it
      // removes the href and leaves the <a>. Render bare text rather than
      // a styled-but-dead link.
      if (!href) {
        return (
          <>
            {lead ? " " : null}
            {children}
            {trail ? " " : null}
          </>
        );
      }
      // Show notes are a link-dense surface (books, sponsors, guest sites) and
      // every one of those clicks used to be invisible. OutboundLink reports
      // only the destination HOST, and stays silent for links back to us.
      return (
        <>
          {lead ? " " : null}
          <OutboundLink
            href={href}
            platform="show_notes_link"
            placement="show_notes"
            rel="noopener noreferrer"
            className="text-cyan underline underline-offset-2 transition hover:text-fg-strong"
          >
            {children}
          </OutboundLink>
          {trail ? " " : null}
        </>
      );
    }

    return undefined;
  },
};

// Recursively flatten a node's text — used to classify leading promo lines.
function textContent(node: DOMNode): string {
  if (isTextNode(node)) return node.data;
  if (isTagNode(node)) return node.children.map(textContent).join("");
  return "";
}

// A paragraph whose visible content is only separator glyphs (renders as a rule).
function isSeparatorParagraph(node: DOMNode): boolean {
  return (
    isTagNode(node) &&
    node.name === "p" &&
    !hasRenderableContent(splitTrailingSeparator(node.children).body)
  );
}

// Cross-promo CTAs that some shows (notably Call Me Back) stack at the very top
// of their notes — "Subscribe to Inside Call Me Back", "Subscribe to Ark News
// Daily" — each a short standalone paragraph, usually fenced by `____` rules.
// Length-capped so a real paragraph that merely opens with "Subscribe" is left
// alone.
const LEADING_PROMO = /^\s*subscribe\b/i;
function isPromoParagraph(node: DOMNode): boolean {
  if (!isTagNode(node) || node.name !== "p") return false;
  const text = textContent(node).trim();
  return text.length > 0 && text.length <= 80 && LEADING_PROMO.test(text);
}

// Skippable filler between/around the promo CTAs: blank text nodes, bare rules,
// and separator-only paragraphs.
function isSkippable(node: DOMNode): boolean {
  if (isTextNode(node)) return node.data.trim() === "";
  if (isTagNode(node)) {
    if (node.name === "hr") return true;
    if (node.name === "p") return isSeparatorParagraph(node);
  }
  return false;
}

// Drops the leading run of promo CTAs (and the separators around them) so every
// show's notes open with the episode itself — matching the shows (e.g. For
// Heaven's Sake) that don't prepend a subscribe block. Only acts when a promo
// actually leads: a standalone rule or a "Subscribe" line later in the body is
// left untouched.
function stripLeadingPromo(nodes: DOMNode[]): DOMNode[] {
  let i = 0;
  let sawPromo = false;
  while (i < nodes.length) {
    const n = nodes[i];
    if (isSkippable(n)) {
      i++;
      continue;
    }
    if (isPromoParagraph(n)) {
      sawPromo = true;
      i++;
      continue;
    }
    break;
  }
  return sawPromo ? nodes.slice(i) : nodes;
}

export function renderShowNotes(html: string) {
  const dom = htmlToDOM(html) as DOMNode[];
  return domToReact(stripLeadingPromo(dom), showNotesParserOptions);
}
