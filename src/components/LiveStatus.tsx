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
    <div className="border-b border-white/8 bg-navy-900/85 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-2 text-[11px] font-medium uppercase tracking-[0.22em] text-white/55 sm:px-10">
        <span className="flex items-center gap-2">
          <span
            className="live-dot inline-block size-1.5 rounded-full bg-cyan"
            aria-hidden="true"
          />
          <span className="text-white/40">On deck</span>
          <span className="hidden text-white/55 sm:inline">·</span>
          <Link
            to={drop.show.route}
            className="text-white transition hover:text-cyan"
          >
            {drop.show.shortTitle}
          </Link>
          <span className="text-white/55">{drop.relative}</span>
        </span>
        <span className="hidden text-cyan sm:inline">Subscriber Edition</span>
      </div>
    </div>
  );
}
