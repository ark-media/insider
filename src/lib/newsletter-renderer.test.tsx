/// <reference types="bun" />
// Beehiiv newsletter renderer tests.
//
// The renderer trusts that its input has already been sanitized server-side
// (input is typed SanitizedHtml). These tests pin the *client-side* behavior:
// block classification, anchor scheme allowlisting (defense in depth in case
// the upstream sanitizer config regresses), title-leak suppression with
// smart-quote tolerance, and episode-title parsing that handles subtitles.

import { describe, test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewsletterArticle } from "./newsletter-renderer";
import { unsafeAssumeSanitized } from "../../shared/sanitized-html";

function render(html: string, postTitle?: string): string {
  return renderToStaticMarkup(
    <NewsletterArticle
      html={unsafeAssumeSanitized(html)}
      postTitle={postTitle}
    />,
  );
}

describe("NewsletterArticle — Beehiiv shape", () => {
  test("classifies hero image + section heading + episode card", () => {
    const out = render(
      [
        '<a href="https://ark.media/issue"><img src="https://cdn.example.com/banner.png" alt="banner" /></a>',
        "<h2>Weekly Round-Up</h2>",
        '<a href="https://example.com/listen"><img src="https://cdn.example.com/cover.jpg" alt="cover" /></a>',
        "<h3>Pod Save America, May 20th</h3>",
        "<p>Episode summary line.</p>",
      ].join(""),
    );
    // Hero figure
    expect(out).toContain('src="https://cdn.example.com/banner.png"');
    // Section heading
    expect(out).toContain("Weekly Round-Up");
    // Episode card title parsed into show + date
    expect(out).toContain("Pod Save America");
    expect(out).toContain("May 20th");
    expect(out).toContain("Episode summary line.");
    // Numbered chip
    expect(out).toContain("№ 01");
  });

  test("episode title with a subtitle keeps the subtitle on the show side", () => {
    const out = render(
      [
        '<a href="https://example.com/listen"><img src="https://cdn.example.com/cover.jpg" alt="cover" /></a>',
        "<h3>Pod Save America, Special Edition, May 20</h3>",
        "<p>x</p>",
      ].join(""),
    );
    expect(out).toContain("Pod Save America, Special Edition");
    expect(out).toContain("May 20");
  });
});

describe("NewsletterArticle — defense in depth", () => {
  test("drops javascript: hrefs and renders children as bare text", () => {
    const out = render(
      "<p>see <a href=\"javascript:alert(1)\">click</a> here</p>",
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a");
    expect(out).toContain("click");
  });

  test("drops data: hrefs", () => {
    const out = render(
      "<p>see <a href=\"data:text/html,<script>x</script>\">click</a></p>",
    );
    expect(out).not.toContain("data:text/html");
    expect(out).not.toContain("<a");
  });

  test("keeps http(s) and mailto anchors", () => {
    const out = render(
      [
        '<p><a href="https://example.com/x">https</a>',
        ' <a href="http://example.com/y">http</a>',
        ' <a href="mailto:hi@ark.media">mail</a></p>',
      ].join(""),
    );
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('href="http://example.com/y"');
    expect(out).toContain('href="mailto:hi@ark.media"');
  });
});

describe("NewsletterArticle — title-leak suppression", () => {
  test("drops a stray title text node at the top of the body", () => {
    const out = render(
      "Title Of The Issue<p>The real lede paragraph.</p>",
      "Title Of The Issue",
    );
    expect(out).toContain("The real lede paragraph.");
    // No raw title leaking outside the masthead. The masthead is rendered
    // by the route, not this component, so the title shouldn't appear here.
    expect(out).not.toContain("Title Of The Issue");
  });

  test("smart-quote variant still matches the post title", () => {
    // Beehiiv often emits curly apostrophes; our match must tolerate that.
    const out = render(
      "We’re Back<p>Hi there.</p>",
      "We're Back",
    );
    expect(out).toContain("Hi there.");
    expect(out).not.toContain("We’re Back");
  });
});

describe("NewsletterArticle — malformed input", () => {
  test("orphan h3 (no preceding image, no hr/) renders without crashing", () => {
    const out = render("<h3>Standalone heading</h3><p>Body.</p>");
    expect(out).toContain("Standalone heading");
    expect(out).toContain("Body.");
  });

  test("empty input renders an empty wrapper, not a throw", () => {
    expect(() => render("")).not.toThrow();
  });

  test("only Beehiiv noise (mailing address) renders nothing of substance", () => {
    const out = render(
      "<p>Ark Media · 268 E Broadway · New York, NY 10002-5672 · USA</p>",
    );
    expect(out).not.toContain("268 E Broadway");
  });
});
