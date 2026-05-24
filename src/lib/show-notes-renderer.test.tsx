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

  test("renders a separator-only paragraph as a rule, not underscores", () => {
    const out = render("<p>____</p>");
    expect(out).toContain("<hr");
    expect(out).not.toContain("____");
  });

  test("peels a trailing <br> + separator off a real paragraph", () => {
    // Neutral (non-promo) lead text: a "Subscribe to…" lead is now stripped as
    // a promo CTA (see the leading-promo tests below), so this case uses plain
    // content to isolate the trailing-separator peel.
    const out = render(
      '<p>More at <a href="https://example.com">the site</a><br /> ____</p>',
    );
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("<hr");
    expect(out).not.toContain("____");
  });

  test("does not treat dash-led headline text as a separator", () => {
    const out = render("<p>- Smotrich responds to the ICC warrant</p>");
    expect(out).not.toContain("<hr");
    expect(out).toContain("Smotrich responds to the ICC warrant");
  });

  test("renders a dash-led headline as a marker line, stripping the glyph", () => {
    // The double space after the hyphen is intentional — authors are
    // inconsistent, and the marker treatment should normalize it away.
    const out = render("<p>-  Smotrich responds</p>");
    expect(out).toContain("pl-5");
    expect(out).toContain(">Smotrich responds</p>");
    expect(out).not.toContain("- Smotrich");
  });

  test("leaves an em-dash paragraph as plain prose, not a marker line", () => {
    const out = render("<p>— Deborah Pardes, host</p>");
    expect(out).not.toContain("pl-5");
    expect(out).toContain("Deborah Pardes, host");
  });

  test("pulls whitespace out of the anchor so the underline hugs the text", () => {
    const out = render(
      '<li>Subscribe to<a href="https://example.com"> Inside</a></li>',
    );
    expect(out).toContain(">Inside</a>");
    expect(out).not.toContain("> Inside</a>");
  });

  test("strips a leading subscribe-promo block so the episode content leads", () => {
    // Call Me Back opens its notes with cross-promo CTAs fenced by `____`
    // rules; For Heaven's Sake opens with the episode. Normalize CMB to match.
    const html =
      '<p>Subscribe to <a href="https://inside.example">Inside Call Me Back</a>.</p>' +
      "<p>____</p>" +
      '<p>Subscribe to <a href="https://and.example">Ark News Daily</a></p>' +
      "<p>____</p>" +
      "<p>Was the summit a win?</p>";
    const out = render(html);
    expect(out).not.toContain("Inside Call Me Back");
    expect(out).not.toContain("Ark News Daily");
    expect(out).not.toContain("<hr");
    expect(out.startsWith("<p>Was the summit a win?")).toBe(true);
  });

  test("leaves notes that open with episode content untouched", () => {
    // A "Subscribe" line in the body (not leading) is real content and stays.
    const out = render(
      "<p>Can an army keep its ethics?</p><p>Subscribe to the feed.</p>",
    );
    expect(out).toContain("Can an army keep its ethics?");
    expect(out).toContain("Subscribe to the feed.");
  });

  test("keeps a long paragraph that merely opens with 'Subscribe'", () => {
    const long =
      "Subscribe and you will hear how the coalition math actually breaks down across three plausible scenarios this spring.";
    const out = render(`<p>${long}</p>`);
    expect(out).toContain(long);
  });
});
