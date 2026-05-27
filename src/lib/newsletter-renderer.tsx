// Beehiiv newsletter renderer.
//
// Trust boundary: input is typed as `SanitizedHtml`, which is produced by
// `sanitizeBeehiivHtml` (server/beehiiv-posts.ts). html-react-parser does
// not re-sanitize. The brand is enforced at compile time — a caller can't
// hand raw HTML to <NewsletterArticle> without an explicit, greppable cast.
// As defense in depth, anchor hrefs are also re-checked against a scheme
// allowlist at render time so a regression in the upstream sanitizer config
// can't silently leak `javascript:`/`data:` urls into the DOM.
//
// Why this exists alongside show-notes-renderer: Beehiiv newsletters are a
// different shape from Simplecast show notes. They're Mailchimp-style
// composed emails — share buttons, social-follow icons, banner imagery, a
// promo block, a stack of episode cards (image + h3 + paragraphs), a
// "listen on Spotify/Apple" footer, and a mailing address. Rendered with
// the show-notes parser they're a long column of orphan elements. This
// renderer recognizes the structural patterns and groups them into
// editorial blocks: a hero, a section header, a promo card, numbered
// episode cards, and a closing flourish.

import { type ReactNode } from "react";
import {
  domToReact,
  htmlToDOM,
  type DOMNode,
  type HTMLReactParserOptions,
} from "html-react-parser";
import type { SanitizedHtml } from "../../shared/sanitized-html";

// Anchor-href scheme allowlist. Mirrors the upstream sanitize-html config
// (http/https/mailto) plus same-document fragments. Any other scheme (or a
// missing href) renders the anchor's children as bare text rather than a
// clickable link.
const SAFE_HREF_RE = /^(?:https?:|mailto:|#)/i;

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  return SAFE_HREF_RE.test(trimmed) ? trimmed : undefined;
}

// Normalize-compare for matching titles that Beehiiv may have smart-quoted,
// re-cased, or padded. Avoids re-emitting the title in body content just
// because the upstream apostrophe is curly vs straight.
function normalizeForCompare(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Node helpers (duck-typed — html-dom-parser ships its own domhandler copy so
// `instanceof Element/Text` would not match the runtime classes).
// ---------------------------------------------------------------------------

type TagNode = DOMNode & {
  name: string;
  attribs: Record<string, string>;
  children: DOMNode[];
};

type TextNode = DOMNode & { data: string };

function isTag(n: DOMNode): n is TagNode {
  return n.type === "tag";
}

function isText(n: DOMNode): n is TextNode {
  return n.type === "text";
}

function isWhitespace(n: DOMNode): boolean {
  return isText(n) && n.data.trim() === "";
}

function textOf(n: DOMNode): string {
  if (isText(n)) return n.data;
  if (isTag(n)) return n.children.map(textOf).join("");
  return "";
}

function findFirstImg(n: DOMNode): TagNode | null {
  if (isTag(n) && n.name === "img") return n;
  if (isTag(n)) {
    for (const c of n.children) {
      const r = findFirstImg(c);
      if (r) return r;
    }
  }
  return null;
}

function nextSignificant(nodes: DOMNode[], start: number): number | null {
  for (let k = start; k < nodes.length; k++) {
    if (!isWhitespace(nodes[k])) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Noise classification — chrome Beehiiv emits for inboxes that has no place
// on the site. We already have a header, theme, and footer; the email's
// social/listen icons and mailing address are redundant.
// ---------------------------------------------------------------------------

// Mailchimp ships icon assets from this CDN; Beehiiv proxies a few defaults.
const NOISE_IMAGE_SRC = /cdn-images\.mailchimp\.com|static_assets\/gradient_avatar_/i;

// Alt-text allowlist for noise: exact-match social/listen badges + the Ark
// Media logo banner the email composer pins to top and bottom. "x (twitter)"
// (and variants) covers the renamed social icon without dropping editorial
// images that happen to have alt text "x".
const NOISE_IMAGE_ALT = /^(ark media|instagram|tiktok|x \(twitter\)|twitter|youtube|facebook|threads|linkedin|spotify|apple podcasts|listen on .*)$/i;

function isNoiseImage(img: TagNode): boolean {
  const src = img.attribs.src ?? "";
  const alt = (img.attribs.alt ?? "").trim();
  return NOISE_IMAGE_SRC.test(src) || NOISE_IMAGE_ALT.test(alt);
}

function isShareAnchor(n: DOMNode): boolean {
  if (!isTag(n) || n.name !== "a") return false;
  if (textOf(n).trim() !== "") return false;
  const img = findFirstImg(n);
  // Empty <a> with no image at all = Beehiiv share button (icon hidden by
  // sanitization). Empty <a> wrapping a noise image = social-follow icon.
  return !img || isNoiseImage(img);
}

function isForwardLink(n: DOMNode): boolean {
  if (!isTag(n) || n.name !== "a") return false;
  return textOf(n).trim().toLowerCase() === "forward to a friend";
}

function isMailingAddress(n: DOMNode): boolean {
  if (!isTag(n) || n.name !== "p") return false;
  const t = textOf(n).trim();
  // "Ark Media · 268 E Broadway · New York, NY 10002-5672 · USA"
  // Match the · separator + something that looks like a postal code (US ZIP
  // or generic 4-7 char trailing token). Avoids hardcoding "USA" so a
  // publication change of physical address doesn't leak through.
  return (
    t.length < 200 &&
    (t.match(/·/g)?.length ?? 0) >= 2 &&
    /\b\d{5}(?:-\d{4})?\b|\b[A-Z]{2,3}\d{1,4}[A-Z]{0,2}\b/.test(t)
  );
}

function isBylineParagraph(n: DOMNode): boolean {
  // First paragraph that wraps an /authors/ link plus a date — we render the
  // byline in the masthead, so suppress it inside the article body.
  if (!isTag(n) || n.name !== "p") return false;
  return n.children.some(
    (c) => isTag(c) && c.name === "a" && /\/authors\//i.test(c.attribs.href ?? ""),
  );
}

function isStrayTitleText(n: DOMNode, postTitle?: string): boolean {
  // Beehiiv leaks the post title as a bare text run at the very top of the
  // body. Drop it if it matches the title we already render in the masthead.
  // Compare normalized so smart quotes / case / whitespace don't defeat the
  // match.
  if (!isText(n)) return false;
  const t = n.data.trim();
  if (t === "") return true;
  if (!postTitle) return false;
  return normalizeForCompare(t) === normalizeForCompare(postTitle);
}

function isNoise(n: DOMNode, postTitle?: string): boolean {
  if (isWhitespace(n)) return true;
  if (isStrayTitleText(n, postTitle)) return true;
  if (isShareAnchor(n)) return true;
  if (isForwardLink(n)) return true;
  if (isMailingAddress(n)) return true;
  if (isTag(n) && n.name === "img" && isNoiseImage(n)) return true;
  return false;
}

function isHr(n: DOMNode): boolean {
  return isTag(n) && n.name === "hr";
}

type Picture = { src: string; alt: string; href?: string };

function extractPicture(n: DOMNode): Picture | null {
  if (isTag(n) && n.name === "img" && !isNoiseImage(n)) {
    return { src: n.attribs.src ?? "", alt: n.attribs.alt ?? "" };
  }
  if (isTag(n) && n.name === "a") {
    const img = findFirstImg(n);
    if (img && !isNoiseImage(img)) {
      // Only treat the anchor's href as the picture's link target if it's
      // a navigable http(s) URL. Mailto / fragment anchors wrapping a hero
      // image would otherwise become misleading "click to listen" targets.
      const href = n.attribs.href?.trim();
      const linkable = href && /^https?:/i.test(href) ? href : undefined;
      return {
        src: img.attribs.src ?? "",
        alt: img.attribs.alt ?? "",
        href: linkable,
      };
    }
  }
  return null;
}

function isPictureNode(n: DOMNode): boolean {
  return extractPicture(n) !== null;
}

function isClosingHeading(n: DOMNode): boolean {
  if (!isTag(n) || n.name !== "h3") return false;
  return /that['’]?s a wrap/i.test(textOf(n));
}

// ---------------------------------------------------------------------------
// Block model — the renderer walks the top-level DOM children once, groups
// them into editorial blocks, then renders each block.
// ---------------------------------------------------------------------------

type Block =
  | { kind: "hero"; picture: Picture }
  | { kind: "section"; text: string }
  | {
      kind: "promo";
      picture?: Picture;
      lines: DOMNode[];
      cta?: { text: string; href: string };
    }
  | {
      kind: "episode";
      picture?: Picture;
      title: string;
      body: DOMNode[];
    }
  | { kind: "closing"; node: TagNode }
  | { kind: "paragraph"; node: DOMNode }
  | { kind: "rule" };

function classifyBlocks(nodes: DOMNode[], postTitle?: string): Block[] {
  const filtered = nodes.filter((n) => !isNoise(n, postTitle));
  // Suppress the byline paragraph too (masthead carries the byline now).
  const bylineIdx = filtered.findIndex(isBylineParagraph);
  if (bylineIdx !== -1) filtered.splice(bylineIdx, 1);

  const blocks: Block[] = [];
  let i = 0;
  let sectionSeen = false;

  while (i < filtered.length) {
    const n = filtered[i];

    if (isHr(n)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (isTag(n) && n.name === "h2") {
      sectionSeen = true;
      blocks.push({ kind: "section", text: textOf(n).trim() });
      i++;
      continue;
    }

    if (isClosingHeading(n)) {
      blocks.push({ kind: "closing", node: n as TagNode });
      i++;
      continue;
    }

    if (isPictureNode(n)) {
      const picture = extractPicture(n)!;
      const nextIdx = nextSignificant(filtered, i + 1);
      const next = nextIdx !== null ? filtered[nextIdx] : null;

      // image-anchor + h3 + body = episode card
      if (next && isTag(next) && next.name === "h3" && !isClosingHeading(next)) {
        const title = textOf(next).trim();
        const body: DOMNode[] = [];
        let j = nextIdx! + 1;
        while (j < filtered.length) {
          const c = filtered[j];
          if (isHr(c)) break;
          if (isPictureNode(c)) break;
          if (isTag(c) && (c.name === "h2" || c.name === "h3")) break;
          body.push(c);
          j++;
        }
        blocks.push({ kind: "episode", picture, title, body });
        i = j;
        continue;
      }

      // Hero image before the first section — the "Weekly Round-Up" banner.
      if (!sectionSeen) {
        blocks.push({ kind: "hero", picture });
        i++;
        continue;
      }

      // Otherwise: a promo block — image + paragraphs + a CTA link.
      const lines: DOMNode[] = [];
      let cta: { text: string; href: string } | undefined;
      let j = nextIdx ?? i + 1;
      while (j < filtered.length) {
        const c = filtered[j];
        if (isHr(c)) break;
        if (isPictureNode(c)) break;
        if (isTag(c) && (c.name === "h2" || c.name === "h3")) break;
        if (
          isTag(c) &&
          c.name === "a" &&
          textOf(c).trim() !== "" &&
          c.attribs.href
        ) {
          cta = { text: textOf(c).trim(), href: c.attribs.href };
          j++;
          break;
        }
        if (isTag(c) && c.name === "p") lines.push(c);
        j++;
      }
      if (cta || lines.length > 0) {
        blocks.push({ kind: "promo", picture, lines, cta });
        i = j;
        continue;
      }
      // No promo body — render the picture solo.
      blocks.push({ kind: "hero", picture });
      i++;
      continue;
    }

    blocks.push({ kind: "paragraph", node: n });
    i++;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline rendering — for paragraph/list content inside blocks. Anchors
// get the cyan underline treatment; everything else falls through.
// ---------------------------------------------------------------------------

const inlineOptions: HTMLReactParserOptions = {
  replace: (node) => {
    if (!isTag(node)) return undefined;
    if (node.name === "a") {
      const href = safeHref(node.attribs.href);
      const children = domToReact(node.children, inlineOptions);
      // Defense in depth: if the href failed the scheme allowlist (or is
      // missing), render the children as bare text rather than a styled-
      // but-dead link. Same behavior as the show-notes renderer.
      if (!href) return <>{children}</>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan underline decoration-cyan/35 underline-offset-[5px] transition hover:decoration-cyan hover:text-fg-strong"
        >
          {children}
        </a>
      );
    }
    if (node.name === "img" && isNoiseImage(node)) {
      return <></>;
    }
    return undefined;
  },
};

function renderInline(nodes: DOMNode[]): ReactNode {
  return domToReact(nodes, inlineOptions);
}

// ---------------------------------------------------------------------------
// Block components — every visual decision lives here.
// ---------------------------------------------------------------------------

const PROSE_BODY =
  "space-y-4 text-[15.5px] leading-[1.75] text-fg [&_p]:break-words [&_em]:italic [&_i]:italic [&_strong]:font-semibold [&_strong]:text-fg-strong [&_b]:font-semibold [&_b]:text-fg-strong";

function HeroImage({ picture }: { picture: Picture }) {
  // The banner is decorative — link it through if Beehiiv attached an href,
  // but never as a tappable promo. Subtle border and a soft cyan glow on the
  // top edge keep it from feeling like a stock email banner.
  return (
    <figure className="relative overflow-hidden border border-rule bg-navy-800/40">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan/60 to-transparent" />
      <img
        src={picture.src}
        alt={picture.alt}
        loading="lazy"
        className="block w-full"
      />
    </figure>
  );
}

function SectionHeading({ text }: { text: string }) {
  return (
    <div className="flex items-baseline gap-4 pt-2">
      <span aria-hidden className="h-px flex-1 bg-rule" />
      <h2 className="text-center font-display text-[11px] font-semibold uppercase tracking-[0.32em] text-cyan">
        {text}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-rule" />
    </div>
  );
}

function PromoCard({
  picture,
  lines,
  cta,
}: {
  picture?: Picture;
  lines: DOMNode[];
  cta?: { text: string; href: string };
}) {
  // Title eyebrow = the first paragraph that's only a <strong> child.
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i];
    if (!isTag(p) || p.name !== "p") continue;
    const kids = (p.children as DOMNode[]).filter((c) => !isWhitespace(c));
    if (kids.length === 1 && isTag(kids[0]) && kids[0].name === "strong") {
      titleIdx = i;
      break;
    }
  }
  const titleText =
    titleIdx >= 0 ? textOf(lines[titleIdx]).trim() : undefined;
  const bodyLines = titleIdx >= 0
    ? lines.filter((_, i) => i !== titleIdx)
    : lines;

  return (
    <aside className="relative grid grid-cols-1 overflow-hidden border border-cyan/35 bg-navy-800/40 shadow-cover lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-full w-[3px] bg-cyan"
      />
      {picture ? (() => {
        // Promo image links through to whichever destination we have (picture
        // anchor first, falling back to the CTA). When neither resolves to a
        // safe scheme, render an unwrapped figure so an empty href doesn't
        // become an accidental "scroll to top" click target.
        const linkTo = safeHref(picture.href) ?? safeHref(cta?.href);
        const wrapClass =
          "relative block overflow-hidden border-b border-cyan/25 lg:border-b-0 lg:border-r";
        const img = (
          <img
            src={picture.src}
            alt={picture.alt}
            loading="lazy"
            className="block aspect-[16/10] w-full object-cover transition duration-700 hover:scale-[1.03] lg:aspect-auto lg:h-full"
          />
        );
        return linkTo ? (
          <a href={linkTo} target="_blank" rel="noopener noreferrer" className={wrapClass}>
            {img}
          </a>
        ) : (
          <figure className={wrapClass}>{img}</figure>
        );
      })() : null}
      <div className="flex flex-col justify-center gap-4 p-7 lg:p-9">
        {titleText ? (
          <div className="font-display text-[12px] font-bold uppercase tracking-[0.28em] text-cyan">
            {titleText}
          </div>
        ) : null}
        {bodyLines.length > 0 ? (
          <div className="space-y-2 text-[15.5px] leading-[1.6] text-fg [&_strong]:text-fg-strong [&_strong]:font-semibold">
            {renderInline(bodyLines)}
          </div>
        ) : null}
        {(() => {
          const ctaHref = safeHref(cta?.href);
          return cta && ctaHref ? (
            <a
              href={ctaHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex w-fit items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
            >
              {cta.text} <span aria-hidden>→</span>
            </a>
          ) : null;
        })()}
      </div>
    </aside>
  );
}

// Split the h3 episode title into "Show name" and "Date". Targets the
// comma immediately preceding a date-shaped token ("May 20", "May 20th",
// "5/20") rather than the first comma, so "Pod Save America, Special
// Edition, May 20" keeps "Pod Save America, Special Edition" as the show
// and "May 20" as the date instead of dropping the subtitle.
const DATE_COMMA_RE =
  /,\s*(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b|\d{1,2}[/.-]\d{1,2})/i;

function splitEpisodeTitle(title: string): { show: string; date?: string } {
  const m = DATE_COMMA_RE.exec(title);
  if (!m) {
    // Fall back to a plain first-comma split when no date-shaped token
    // is found, so episodes formatted "Show, freeform tail" still split.
    const idx = title.indexOf(",");
    if (idx === -1) return { show: title };
    return { show: title.slice(0, idx).trim(), date: title.slice(idx + 1).trim() };
  }
  return {
    show: title.slice(0, m.index).trim(),
    date: title.slice(m.index + m[0].length).trim(),
  };
}

function EpisodeCard({
  picture,
  title,
  body,
  index,
}: {
  picture?: Picture;
  title: string;
  body: DOMNode[];
  index: number;
}) {
  const { show, date } = splitEpisodeTitle(title);
  const num = String(index).padStart(2, "0");
  const listenHref = safeHref(picture?.href);

  return (
    <article className="group relative grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-10">
      {picture ? (() => {
        // Skip the anchor wrapper when there's no safe href — an
        // <a href="#"> here would silently scroll to top on click.
        const wrapClass =
          "relative block overflow-hidden border border-rule bg-navy-800/40";
        const inner = (
          <>
            <img
              src={picture.src}
              alt={picture.alt}
              loading="lazy"
              className="block aspect-[16/9] w-full object-cover transition duration-700 group-hover:scale-[1.04]"
            />
            <span className="pointer-events-none absolute bottom-3 right-3 border border-cyan/60 bg-navy/90 px-2.5 py-1 font-display text-[10px] font-bold uppercase tracking-[0.28em] text-cyan backdrop-blur-sm">
              № {num}
            </span>
          </>
        );
        return listenHref ? (
          <a href={listenHref} target="_blank" rel="noopener noreferrer" className={wrapClass}>
            {inner}
          </a>
        ) : (
          <figure className={wrapClass}>{inner}</figure>
        );
      })() : (
        <div className="hidden lg:block" />
      )}
      <div className="flex flex-col">
        <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-3">
          <span className="font-display text-[11.5px] font-bold uppercase tracking-[0.22em] text-cyan">
            {show}
          </span>
          {date ? (
            <span className="shrink-0 text-[10.5px] uppercase tracking-[0.22em] text-fg-faint">
              {date}
            </span>
          ) : null}
        </div>
        <div className={`mt-5 ${PROSE_BODY}`}>{renderInline(body)}</div>
        {listenHref ? (
          <a
            href={listenHref}
            target="_blank"
            rel="noopener noreferrer"
            className="group/listen mt-6 inline-flex w-fit items-center gap-2 self-start font-display text-[11.5px] font-bold uppercase tracking-[0.22em] text-cyan transition hover:text-fg-strong"
          >
            Listen
            <span
              aria-hidden
              className="inline-block transition group-hover/listen:translate-x-1"
            >
              →
            </span>
          </a>
        ) : null}
      </div>
    </article>
  );
}

function ClosingFlourish({ node }: { node: TagNode }) {
  return (
    <div className="relative py-4 text-center">
      <div className="mx-auto mb-6 h-px w-20 bg-cyan/60" />
      <p className="font-display text-[18px] leading-[1.4] text-fg-strong">
        {renderInline(node.children)}
      </p>
    </div>
  );
}

function PlainBlock({ node }: { node: DOMNode }) {
  return <div className={PROSE_BODY}>{renderInline([node])}</div>;
}

// ---------------------------------------------------------------------------
// Top-level render. Use <NewsletterArticle> to render the sanitized HTML.
// ---------------------------------------------------------------------------

export function NewsletterArticle({
  html,
  postTitle,
}: {
  html: SanitizedHtml;
  postTitle?: string;
}) {
  const dom = htmlToDOM(html) as DOMNode[];
  const blocks = classifyBlocks(dom, postTitle);

  // Number episodes within the article so each card carries a "№ NN" chip.
  let episodeIndex = 0;
  // Suppress consecutive rules — Beehiiv puts an <hr/> between every block,
  // but our cards already carry their own separation.
  // Beehiiv emits an <hr/> between every block; the cards carry their own
  // separation, so drop consecutive rules and rules adjacent to sections.
  const compact: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "rule") {
      const prev = compact[compact.length - 1];
      if (!prev || prev.kind === "rule" || prev.kind === "section") continue;
    }
    compact.push(b);
  }
  // Strip a trailing rule if the article ends on one.
  if (compact[compact.length - 1]?.kind === "rule") compact.pop();

  return (
    <div className="space-y-12">
      {compact.map((block, i) => {
        const key = `${block.kind}-${i}`;
        switch (block.kind) {
          case "hero":
            return <HeroImage key={key} picture={block.picture} />;
          case "section":
            return <SectionHeading key={key} text={block.text} />;
          case "promo":
            return (
              <PromoCard
                key={key}
                picture={block.picture}
                lines={block.lines}
                cta={block.cta}
              />
            );
          case "episode": {
            episodeIndex += 1;
            return (
              <EpisodeCard
                key={key}
                picture={block.picture}
                title={block.title}
                body={block.body}
                index={episodeIndex}
              />
            );
          }
          case "closing":
            return <ClosingFlourish key={key} node={block.node} />;
          case "rule":
            return (
              <hr
                key={key}
                className="mx-auto h-px w-16 border-0 bg-rule"
                aria-hidden
              />
            );
          case "paragraph":
            return <PlainBlock key={key} node={block.node} />;
          default: {
            // Exhaustiveness check. If a new Block kind is added without a
            // case above, this assignment fails to compile. At runtime an
            // unknown kind renders nothing rather than throwing inside
            // React (which would tear down the whole article).
            const _exhaustive: never = block;
            void _exhaustive;
            return null;
          }
        }
      })}
    </div>
  );
}

