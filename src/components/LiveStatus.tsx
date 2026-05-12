import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { nextDrop, type NextDrop } from "../data/shows";

export function LiveStatus() {
  const [drop, setDrop] = useState<NextDrop | null>(() => nextDrop());

  useEffect(() => {
    const id = setInterval(() => setDrop(nextDrop()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!drop) return null;

  return (
    <div className="border-b border-rule-soft bg-navy-900">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-2 text-[11px] font-medium uppercase tracking-eyebrow text-fg-muted sm:px-10">
        <span className="flex items-center gap-2">
          <span
            className="live-dot inline-block size-1.5 rounded-full bg-cyan"
            aria-hidden="true"
          />
          <span className="text-fg-muted">On deck</span>
          <span className="hidden text-fg-muted sm:inline">·</span>
          <Link
            to={drop.show.route}
            className="text-fg-strong transition hover:text-cyan"
          >
            {drop.show.shortTitle}
          </Link>
          <span className="text-fg-muted">{drop.relative}</span>
        </span>
        <span className="hidden text-cyan sm:inline">Subscriber Edition</span>
      </div>
    </div>
  );
}
