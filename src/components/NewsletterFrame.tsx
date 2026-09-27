import { useEffect, useRef, useState } from "react";
import type { SanitizedHtml } from "../../shared/sanitized-html";

// Renders a Beehiiv issue exactly as Beehiiv styles it, in a sandboxed
// `srcdoc` iframe so its CSS can't touch the site and ours can't touch it.
//
// Sandbox: `allow-same-origin` lets us read the frame's height to size it to
// the content (no inner scrollbar). It is safe ONLY because `allow-scripts`
// is absent — the two together would let the document run as our origin.
// Never add `allow-scripts` here. `allow-popups` (+ escape) lets links, which
// the server's `<base target="_blank">` points at new tabs, open normally.
//
// `src` isn't an option: vercel.json sends `X-Frame-Options: DENY` on every
// response, and srcdoc isn't subject to it.
// Beehiiv's page background for our publication (its `bg-wt-background`).
// The frame and the band around it share it so their edges don't show.
export const NEWSLETTER_PAPER = "#F1F4F9";

export function NewsletterFrame({
  html,
  title,
}: {
  html: SanitizedHtml;
  title: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;

    const attach = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      const measure = () => setHeight(doc.documentElement.scrollHeight);
      measure();
      observer?.disconnect();
      // Images load after `load` on slow connections and the frame's width
      // changes with the viewport; both change the height.
      observer = new ResizeObserver(measure);
      observer.observe(doc.documentElement);
      if (doc.body) observer.observe(doc.body);
    };

    frame.addEventListener("load", attach);
    if (frame.contentDocument?.readyState === "complete") attach();
    return () => {
      frame.removeEventListener("load", attach);
      observer?.disconnect();
    };
  }, [html]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer-when-downgrade"
      className="block w-full border-0"
      style={{
        height: height ?? "80vh",
        backgroundColor: NEWSLETTER_PAPER,
        colorScheme: "light",
      }}
    />
  );
}
