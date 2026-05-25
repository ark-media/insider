import { useEffect, useLayoutEffect, useRef, useState } from "react";
import parse from "html-react-parser";
import { fetchActiveAnnouncement, type Announcement } from "../lib/announcements";

// Remembers the last announcement the user dismissed (by id), so re-enabling or
// publishing a *new* announcement surfaces again rather than staying hidden.
const DISMISS_KEY = "ark_announcement_dismissed";

export function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchActiveAnnouncement().then((a) => {
      if (cancelled || !a) return;
      try {
        if (localStorage.getItem(DISMISS_KEY) === a.id) return;
      } catch {
        // Private mode / blocked storage — show the banner rather than crash.
      }
      setAnnouncement(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The banner is sticky; publish its height as --ann-height so the (also
  // sticky) masthead can offset its top and sit flush beneath it. Tracks wraps
  // and resizes; resets to 0 when the banner is gone so the masthead pins to
  // the very top.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = barRef.current;
    if (!announcement || !el) {
      root.style.setProperty("--ann-height", "0px");
      return;
    }
    const apply = () => root.style.setProperty("--ann-height", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty("--ann-height", "0px");
    };
  }, [announcement]);

  if (!announcement) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, announcement.id);
    } catch {
      // Ignore storage failures; dismissal just won't persist.
    }
    setAnnouncement(null);
  };

  const { actionUrl, body, barColor, textColor, dismissible } = announcement;
  const isExternal = actionUrl?.startsWith("http") ?? false;

  return (
    <div
      ref={barRef}
      role="region"
      aria-label="Site announcement"
      className="sticky top-0 z-40"
      style={{ backgroundColor: barColor, color: textColor }}
    >
      {/* Full-bleed click target sits *behind* the content, so the bar is
          clickable without wrapping (and nesting) the body's own links. */}
      {actionUrl ? (
        <a
          href={actionUrl}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noreferrer noopener" : undefined}
          aria-label="Open announcement"
          className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
        />
      ) : null}

      <div className="mx-auto flex max-w-[1280px] items-center justify-center px-10 py-2.5 sm:px-12">
        {/* Text ignores pointer events so clicks fall through to the overlay
            link; the body's own <a> tags opt back in so they stay clickable. */}
        <div className="pointer-events-none relative z-10 text-center text-[13px] font-medium leading-snug sm:text-[14px] [&_a]:pointer-events-auto [&_a]:underline [&_a]:underline-offset-2">
          {parse(body)}
        </div>
      </div>

      {dismissible ? (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="absolute right-2 top-1/2 z-20 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full transition hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          style={{ color: "inherit" }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
