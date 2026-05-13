// Renders sanitized show-notes HTML into React via html-react-parser.
//
// Trust boundary: input MUST come from `sanitizeShowNotes` (server/show-notes.ts).
// html-react-parser does not re-sanitize — it trusts whatever string we hand it.

import parse, {
  domToReact,
  type DOMNode,
  type HTMLReactParserOptions,
} from "html-react-parser";

// Duck-typed element check. We can't use `instanceof Element` from
// html-react-parser because html-dom-parser ships its own copy of domhandler,
// so parsed nodes don't match the Element class we'd import here.
function isTagNode(node: DOMNode): node is DOMNode & {
  name: string;
  attribs: Record<string, string>;
  children: DOMNode[];
} {
  return node.type === "tag";
}

export const showNotesParserOptions: HTMLReactParserOptions = {
  replace: (node) => {
    if (!isTagNode(node)) return undefined;
    if (node.name === "a") {
      const href =
        typeof node.attribs.href === "string" ? node.attribs.href : undefined;
      const children = domToReact(node.children, showNotesParserOptions);
      // When sanitize-html strips an unsafe scheme (e.g. javascript:) it
      // removes the href and leaves the <a>. Render bare text rather than
      // a styled-but-dead link.
      if (!href) return <>{children}</>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan underline underline-offset-2 transition hover:text-fg-strong"
        >
          {children}
        </a>
      );
    }
    return undefined;
  },
};

export function renderShowNotes(html: string) {
  return parse(html, showNotesParserOptions);
}
