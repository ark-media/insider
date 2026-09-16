import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A paragraph that line-clamps via the passed `className` (e.g. `line-clamp-4`)
 * and surfaces the full text in a native hover tooltip — but only when the text
 * is actually truncated. The tooltip is only available when `text` is a plain
 * string; richer nodes render without one.
 */
export function ClampedText({
  text,
  className,
}: {
  text: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);
  const tooltip = typeof text === "string" ? text : undefined;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Truncated when the rendered content is taller than the clamped box.
    const measure = () => setTruncated(el.scrollHeight - el.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return (
    <p ref={ref} className={className} title={truncated ? tooltip : undefined}>
      {text}
    </p>
  );
}
