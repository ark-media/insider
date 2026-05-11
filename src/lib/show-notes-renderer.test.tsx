/// <reference types="bun" />
// Regression tests for the show-notes renderer. Sanitization happens on the
// server (see server/show-notes.test.ts); these tests pin client-side
// behavior on top of already-sanitized input — specifically that anchors
// whose href was stripped by the sanitizer render as bare text, not as
// styled-but-dead links.

import { describe, test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderShowNotes } from "./show-notes-renderer";

function render(html: string): string {
  return renderToStaticMarkup(<>{renderShowNotes(html)}</>);
}

describe("renderShowNotes", () => {
  test("renders well-formed anchors with target and rel", () => {
    const out = render('<p>See <a href="https://example.com/x">notes</a>.</p>');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("notes");
  });

  test("renders bare text when an anchor has no href", () => {
    // Mirrors sanitize-html's output after it strips a javascript: scheme:
    // the <a> tag survives but the href is gone. Should not produce a
    // clickable-looking link.
    const out = render("<p>see <a>click</a> here</p>");
    expect(out).not.toContain("<a");
    expect(out).toContain("click");
  });

  test("preserves paragraphs, lists, and formatting", () => {
    const out = render(
      "<p>Intro.</p><ul><li>One</li></ul><p><strong>bold</strong></p>",
    );
    expect(out).toContain("<p>Intro.</p>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>One</li>");
    expect(out).toContain("<strong>bold</strong>");
  });
});
